import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AsfControlAuthenticationError,
  AsfControlRequestAuthenticator,
  AsfControlRequestSigner,
  type AsfControlAuthentication,
} from "../../src/asf/control-auth.js";
import {
  ASF_CONTROL_AUTH_ENV,
  loadAsfControlAuthenticationKey,
  loadAsfControlRequestAuthenticator,
  loadAsfControlRequestSigner,
} from "../../src/asf/control-auth-config.js";
import { DaemonControlServer, requestDaemon } from "../../src/daemon/control.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:00:00.000Z";
const KEY = {
  controllerId: "asf-controller-prod",
  keyId: "asf-control-2026",
  secret: "dedicated-local-control-secret-material-00000001",
} as const;

function signer(
  clock = new FakeClock(NOW),
  nonce = "base64url:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
): AsfControlRequestSigner {
  return new AsfControlRequestSigner({ key: KEY, clock, nonce: () => nonce });
}

function verifier(
  clock = new FakeClock(NOW),
  maximumLiveNonces = 10_000,
): AsfControlRequestAuthenticator {
  return new AsfControlRequestAuthenticator({
    keys: [KEY],
    clock,
    maximumLiveNonces,
  });
}

function resign(
  authentication: AsfControlAuthentication,
  mutate: (value: Record<string, unknown>) => void,
): AsfControlAuthentication {
  const raw = structuredClone(authentication) as unknown as Record<string, unknown>;
  mutate(raw);
  return raw as unknown as AsfControlAuthentication;
}

describe("ASF local control authentication", () => {
  it("authenticates one exact request from a trusted controller", () => {
    const request = { type: "asf.get_run", runId: "run-01" } as const;
    const authentication = signer().authenticate(request);

    expect(() => verifier().verify(request, authentication)).not.toThrow();
    expect(authentication).toMatchObject({
      schema: "asf.control-authentication/v1",
      controller_id: KEY.controllerId,
      key_id: KEY.keyId,
      issued_at: NOW,
      expires_at: "2026-08-21T10:00:05.000Z",
      nonce: "base64url:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(JSON.stringify(authentication)).not.toContain(KEY.secret);
  });

  it("binds authentication to the exact request and refuses replay", () => {
    const request = { type: "asf.get_run", runId: "run-01" } as const;
    const authentication = signer().authenticate(request);
    const authenticationVerifier = verifier();

    authenticationVerifier.verify(request, authentication);
    expect(() => authenticationVerifier.verify(request, authentication)).toThrow(
      AsfControlAuthenticationError,
    );
    expect(() =>
      verifier().verify({ type: "asf.get_run", runId: "run-02" }, authentication),
    ).toThrow(/binding-mismatch/u);
  });

  it("refuses unknown keys and changed signatures without revealing key material", () => {
    const request = { type: "asf.health" } as const;
    const authentication = signer().authenticate(request);
    const cases = [
      resign(authentication, (raw) => {
        raw["controller_id"] = "untrusted-controller";
      }),
      resign(authentication, (raw) => {
        raw["signature"] = `base64url:${"A".repeat(43)}`;
      }),
    ];

    for (const candidate of cases) {
      let error: unknown;
      try {
        verifier().verify(request, candidate);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AsfControlAuthenticationError);
      expect((error as Error).message).not.toContain(KEY.secret);
    }
  });

  it("refuses expired, future, and overlong capabilities", () => {
    const request = { type: "asf.health" } as const;
    const expiredClock = new FakeClock(NOW);
    const authentication = signer(expiredClock).authenticate(request);
    expiredClock.advanceMs(7_000);
    expect(() => verifier(expiredClock).verify(request, authentication)).toThrow(/invalid-time/u);

    const future = resign(authentication, (raw) => {
      raw["issued_at"] = "2026-08-21T10:01:00.000Z";
      raw["expires_at"] = "2026-08-21T10:01:05.000Z";
    });
    expect(() => verifier().verify(request, future)).toThrow();

    const longSigner = new AsfControlRequestSigner({
      key: KEY,
      clock: new FakeClock(NOW),
      lifetimeMs: 30_000,
      nonce: () => "base64url:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    expect(() => verifier().verify(request, longSigner.authenticate(request))).toThrow(
      /invalid-time/u,
    );
  });

  it("fails closed rather than evicting a still-live replay fence", () => {
    const authenticationVerifier = verifier(new FakeClock(NOW), 1);
    const first = signer(
      new FakeClock(NOW),
      "base64url:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ).authenticate({ type: "asf.health" });
    const second = signer(
      new FakeClock(NOW),
      "base64url:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    ).authenticate({ type: "asf.get_run", runId: "run-01" });

    authenticationVerifier.verify({ type: "asf.health" }, first);
    expect(() =>
      authenticationVerifier.verify({ type: "asf.get_run", runId: "run-01" }, second),
    ).toThrow(/replay-capacity/u);
  });

  it("requires authentication on the real worker control socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-control-auth-"));
    cleanup.push(directory);
    const paths = {
      directory,
      registry: join(directory, "daemon.json"),
      socket: join(directory, "daemon.sock"),
    };
    let calls = 0;
    const server = await DaemonControlServer.start({
      paths,
      repoRoot: "/repo",
      configPath: "/repo/asf-worker.json",
      startedAt: NOW,
      controlAuthentication: verifier(),
      handle: () => {
        calls += 1;
        return { ready: true };
      },
    });
    servers.push(server);

    await expect(requestDaemon({ type: "asf.health" }, paths.registry)).rejects.toThrow(
      /authenticated ASF control request is malformed/u,
    );
    expect(calls).toBe(0);
    await expect(
      requestDaemon({ type: "asf.health" }, paths.registry, 2_000, {
        controlAuthentication: signer(),
      }),
    ).resolves.toEqual({ ready: true });
    expect(calls).toBe(1);
  });

  it("cannot use the ASF-authenticated wire form to control a standalone daemon", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-standalone-auth-boundary-"));
    cleanup.push(directory);
    const paths = {
      directory,
      registry: join(directory, "daemon.json"),
      socket: join(directory, "daemon.sock"),
    };
    let stopCalls = 0;
    const server = await DaemonControlServer.start({
      paths,
      repoRoot: "/repo",
      configPath: "/repo/runmill.yaml",
      startedAt: NOW,
      handle: (request) => {
        if (request.type === "stop") stopCalls += 1;
        return { stopping: true };
      },
    });
    servers.push(server);

    await expect(
      requestDaemon({ type: "stop" }, paths.registry, 2_000, {
        controlAuthentication: signer(),
      }),
    ).rejects.toThrow(/control request/u);
    expect(stopCalls).toBe(0);

    await expect(requestDaemon({ type: "stop" }, paths.registry)).resolves.toEqual({
      stopping: true,
    });
    expect(stopCalls).toBe(1);
  });
});

const cleanup: string[] = [];
const servers: DaemonControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ASF control key loading", () => {
  it("loads one private key for both signer and authenticator", () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-control-key-"));
    cleanup.push(directory);
    const keyFile = join(directory, "control.key");
    writeFileSync(keyFile, `${KEY.secret}\n`, { mode: 0o600 });
    const env = {
      [ASF_CONTROL_AUTH_ENV.controllerId]: KEY.controllerId,
      [ASF_CONTROL_AUTH_ENV.keyId]: KEY.keyId,
      [ASF_CONTROL_AUTH_ENV.keyFile]: keyFile,
    };

    expect(loadAsfControlAuthenticationKey(env)).toEqual(KEY);
    const request = { type: "asf.health" } as const;
    const authentication = loadAsfControlRequestSigner(
      new FakeClock(NOW),
      env,
    ).authenticate(request);
    expect(() =>
      loadAsfControlRequestAuthenticator(new FakeClock(NOW), env).verify(
        request,
        authentication,
      ),
    ).not.toThrow();
  });

  it("refuses relative, symlinked, short, and non-private key files", () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-control-key-"));
    cleanup.push(directory);
    const keyFile = join(directory, "control.key");
    const linkFile = join(directory, "control-link.key");
    writeFileSync(keyFile, "short", { mode: 0o600 });
    symlinkSync(keyFile, linkFile);
    const base = {
      [ASF_CONTROL_AUTH_ENV.controllerId]: KEY.controllerId,
      [ASF_CONTROL_AUTH_ENV.keyId]: KEY.keyId,
    };

    for (const candidate of ["relative.key", linkFile, keyFile]) {
      expect(() =>
        loadAsfControlAuthenticationKey({
          ...base,
          [ASF_CONTROL_AUTH_ENV.keyFile]: candidate,
        }),
      ).toThrow();
    }

    writeFileSync(keyFile, KEY.secret, { mode: 0o600 });
    chmodSync(keyFile, 0o644);
    expect(() =>
      loadAsfControlAuthenticationKey({
        ...base,
        [ASF_CONTROL_AUTH_ENV.keyFile]: keyFile,
      }),
    ).toThrow(/private regular file/u);
  });

  it("refuses a private-looking key inside a writable control directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-control-key-parent-"));
    cleanup.push(directory);
    const keyFile = join(directory, "control.key");
    writeFileSync(keyFile, KEY.secret, { mode: 0o600 });
    chmodSync(directory, 0o777);

    expect(() =>
      loadAsfControlAuthenticationKey({
        [ASF_CONTROL_AUTH_ENV.controllerId]: KEY.controllerId,
        [ASF_CONTROL_AUTH_ENV.keyId]: KEY.keyId,
        [ASF_CONTROL_AUTH_ENV.keyFile]: keyFile,
      }),
    ).toThrow(/private regular file/u);
  });
});
