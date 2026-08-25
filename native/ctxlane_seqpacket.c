/*
 * First-party Linux ctxlane transport.
 *
 * This is deliberately a very small N-API boundary.  It does not parse or
 * manufacture ctxlane authority; it moves exactly one bounded JSON record
 * over a directly-connected AF_UNIX/SOCK_SEQPACKET socket and returns the
 * peer's record to the TypeScript contract validator.
 *
 * The addon is only compiled on Linux.  In particular, there is no stream or
 * child-process fallback here.  A missing addon is an unavailable transport.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <node_api.h>

#ifdef __linux__

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef SO_PEERPIDFD
/* Linux 6.5+ exposes this in recent headers.  Keep older build images
 * source-compatible, while refusing at runtime when the option is absent. */
#define SO_PEERPIDFD 77
#endif

#define MAX_UNIX_PATH_BYTES 107U
#define MAX_PEER_TEXT_BYTES 4096U
#define ERROR_TEXT_BYTES 192U
#ifndef SCM_MAX_FD
#define SCM_MAX_FD 253U
#endif
#define ANCILLARY_BUFFER_BYTES \
  (CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(SCM_MAX_FD * sizeof(int)))

typedef struct {
  char *path;
  size_t path_len;
  uint8_t *request;
  size_t request_len;
  size_t max_message_bytes;
  uint32_t timeout_ms;
  uid_t *trusted_uids;
  size_t trusted_uid_count;
  char *expected_executable;
  char *expected_cgroup;
  struct stat expected_executable_stat;
  uint8_t expected_executable_digest[32];
  int have_expected_executable_identity;
  uint8_t *response;
  size_t response_len;
  napi_async_work work;
  napi_deferred deferred;
  int status;
  char error[ERROR_TEXT_BYTES];
} exchange_work;

static int same_stat(const struct stat *left, const struct stat *right);
static int trusted_uid(const exchange_work *work, uid_t uid);

typedef struct {
  uint32_t state[8];
  uint64_t bit_count;
  uint8_t block[64];
  size_t block_len;
} sha256_context;

static uint32_t rotate_right(uint32_t value, uint32_t count) {
  return (value >> count) | (value << (32U - count));
}

static const uint32_t SHA256_ROUND_CONSTANTS[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU,
    0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U, 0xd807aa98U, 0x12835b01U,
    0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U,
    0xc19bf174U, 0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
    0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU, 0x983e5152U,
    0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U,
    0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU,
    0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U,
    0xd6990624U, 0xf40e3585U, 0x106aa070U, 0x19a4c116U, 0x1e376c08U,
    0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU,
    0x682e6ff3U, 0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U};

static void sha256_transform(sha256_context *context, const uint8_t *block) {
  uint32_t schedule[64];
  uint32_t a;
  uint32_t b;
  uint32_t c;
  uint32_t d;
  uint32_t e;
  uint32_t f;
  uint32_t g;
  uint32_t h;
  uint32_t i;

  for (i = 0; i < 16; ++i) {
    schedule[i] = ((uint32_t)block[i * 4] << 24) |
                  ((uint32_t)block[i * 4 + 1] << 16) |
                  ((uint32_t)block[i * 4 + 2] << 8) | (uint32_t)block[i * 4 + 3];
  }
  for (i = 16; i < 64; ++i) {
    uint32_t small_sigma_zero =
        rotate_right(schedule[i - 15], 7) ^ rotate_right(schedule[i - 15], 18) ^
        (schedule[i - 15] >> 3);
    uint32_t small_sigma_one =
        rotate_right(schedule[i - 2], 17) ^ rotate_right(schedule[i - 2], 19) ^
        (schedule[i - 2] >> 10);
    schedule[i] = schedule[i - 16] + small_sigma_zero + schedule[i - 7] + small_sigma_one;
  }
  a = context->state[0];
  b = context->state[1];
  c = context->state[2];
  d = context->state[3];
  e = context->state[4];
  f = context->state[5];
  g = context->state[6];
  h = context->state[7];
  for (i = 0; i < 64; ++i) {
    uint32_t big_sigma_one = rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
    uint32_t choose = (e & f) ^ ((~e) & g);
    uint32_t temporary_one = h + big_sigma_one + choose + SHA256_ROUND_CONSTANTS[i] + schedule[i];
    uint32_t big_sigma_zero = rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temporary_two = big_sigma_zero + majority;
    h = g;
    g = f;
    f = e;
    e = d + temporary_one;
    d = c;
    c = b;
    b = a;
    a = temporary_one + temporary_two;
  }
  context->state[0] += a;
  context->state[1] += b;
  context->state[2] += c;
  context->state[3] += d;
  context->state[4] += e;
  context->state[5] += f;
  context->state[6] += g;
  context->state[7] += h;
}

static void sha256_init(sha256_context *context) {
  static const uint32_t initial_state[8] = {
      0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
      0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U};
  (void)memcpy(context->state, initial_state, sizeof(initial_state));
  context->bit_count = 0;
  context->block_len = 0;
}

static void sha256_update(sha256_context *context, const uint8_t *data, size_t length) {
  context->bit_count += (uint64_t)length * 8U;
  while (length > 0) {
    size_t available = sizeof(context->block) - context->block_len;
    size_t copy_length = length < available ? length : available;
    (void)memcpy(context->block + context->block_len, data, copy_length);
    context->block_len += copy_length;
    data += copy_length;
    length -= copy_length;
    if (context->block_len == sizeof(context->block)) {
      sha256_transform(context, context->block);
      context->block_len = 0;
    }
  }
}

static void sha256_final(sha256_context *context, uint8_t digest[32]) {
  uint64_t bit_count = context->bit_count;
  size_t i;
  context->block[context->block_len++] = 0x80;
  while (context->block_len != 56) {
    if (context->block_len == sizeof(context->block)) {
      sha256_transform(context, context->block);
      context->block_len = 0;
    }
    context->block[context->block_len++] = 0;
  }
  for (i = 0; i < 8; ++i)
    context->block[56 + i] = (uint8_t)(bit_count >> (56 - i * 8));
  sha256_transform(context, context->block);
  for (i = 0; i < 8; ++i) {
    digest[i * 4] = (uint8_t)(context->state[i] >> 24);
    digest[i * 4 + 1] = (uint8_t)(context->state[i] >> 16);
    digest[i * 4 + 2] = (uint8_t)(context->state[i] >> 8);
    digest[i * 4 + 3] = (uint8_t)context->state[i];
  }
}

static int hash_fd(int fd, uint8_t digest[32]) {
  uint8_t buffer[16 * 1024];
  sha256_context context;
  ssize_t count;
  if (lseek(fd, 0, SEEK_SET) < 0) return -1;
  sha256_init(&context);
  for (;;) {
    count = read(fd, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    sha256_update(&context, buffer, (size_t)count);
  }
  sha256_final(&context, digest);
  return 0;
}

static int hash_path(const char *path, uint8_t digest[32]) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  int result;
  if (fd < 0) return -1;
  result = hash_fd(fd, digest);
  (void)close(fd);
  return result;
}

static int same_file_identity(const struct stat *left, const struct stat *right) {
  return same_stat(left, right) && left->st_nlink == right->st_nlink;
}

static int snapshot_expected_executable(exchange_work *work) {
  int fd = -1;
  struct stat metadata;
  if (work->expected_executable == NULL || work->expected_executable[0] == '\0') return -1;
  fd = open(work->expected_executable, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0 || fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
      metadata.st_nlink != 1 || !trusted_uid(work, metadata.st_uid) ||
      (metadata.st_mode & 0022) != 0 || (metadata.st_mode & 06000) != 0 ||
      (metadata.st_mode & 0111) == 0 || hash_fd(fd, work->expected_executable_digest) != 0) {
    if (fd >= 0) (void)close(fd);
    return -1;
  }
  (void)close(fd);
  work->expected_executable_stat = metadata;
  work->have_expected_executable_identity = 1;
  return 0;
}

static int valid_cgroup_identity(const char *cgroup) {
  return cgroup != NULL && strncmp(cgroup, "0::/", 4) == 0 &&
         strchr(cgroup, '\n') == NULL && strchr(cgroup, '\r') == NULL;
}

static void set_error(exchange_work *work, const char *message) {
  if (work->status != 0) return;
  work->status = EPROTO;
  (void)snprintf(work->error, sizeof(work->error), "%s", message);
}

static int same_stat(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_uid == right->st_uid && left->st_gid == right->st_gid &&
         left->st_mode == right->st_mode;
}

static int trusted_uid(const exchange_work *work, uid_t uid) {
  size_t i;
  for (i = 0; i < work->trusted_uid_count; ++i) {
    if (work->trusted_uids[i] == uid) return 1;
  }
  return 0;
}

static int read_text_file(const char *path, char *buffer, size_t capacity) {
  int fd = -1;
  ssize_t count;
  if (capacity < 2) return -1;
  fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  count = read(fd, buffer, capacity - 1);
  (void)close(fd);
  if (count < 0 || (size_t)count >= capacity) return -1;
  buffer[count] = '\0';
  while (count > 0 && (buffer[count - 1] == '\n' || buffer[count - 1] == '\r')) {
    buffer[count - 1] = '\0';
    --count;
  }
  return 0;
}

static int attest_peer(exchange_work *work, int fd, struct ucred *peer_out,
                        int *peer_pidfd_out) {
  struct ucred peer;
  socklen_t peer_len = sizeof(peer);
  int peer_pidfd = -1;
  socklen_t pidfd_len = sizeof(peer_pidfd);
  char proc_path[128];
  char executable[PATH_MAX];
  char cgroup[MAX_PEER_TEXT_BYTES];
  struct stat executable_stat;
  uint8_t executable_digest[32];
  int pidfd_flags;
  ssize_t executable_len;

  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &peer_len) != 0 ||
      peer_len != sizeof(peer)) {
    set_error(work, "ctxlane peer credentials unavailable");
    return -1;
  }
  if (!trusted_uid(work, peer.uid)) {
    set_error(work, "ctxlane peer credentials are not bound");
    return -1;
  }
  if (getsockopt(fd, SOL_SOCKET, SO_PEERPIDFD, &peer_pidfd, &pidfd_len) != 0 ||
      peer_pidfd < 0 || pidfd_len != sizeof(peer_pidfd)) {
    set_error(work, "ctxlane peer pidfd unavailable");
    return -1;
  }
  pidfd_flags = fcntl(peer_pidfd, F_GETFD);
  if (pidfd_flags < 0 || fcntl(peer_pidfd, F_SETFD, pidfd_flags | FD_CLOEXEC) < 0) {
    (void)close(peer_pidfd);
    set_error(work, "ctxlane peer pidfd is invalid");
    return -1;
  }
  {
    struct pollfd peer_poll;
    int poll_result;
    memset(&peer_poll, 0, sizeof(peer_poll));
    peer_poll.fd = peer_pidfd;
    peer_poll.events = POLLIN | POLLERR | POLLHUP | POLLNVAL;
    poll_result = poll(&peer_poll, 1, 0);
    if (poll_result < 0 || (poll_result > 0 && peer_poll.revents != 0)) {
      (void)close(peer_pidfd);
      set_error(work, "ctxlane peer process is not live");
      return -1;
    }
  }

  if (work->expected_executable == NULL || work->expected_cgroup == NULL ||
      work->expected_executable[0] == '\0' || !valid_cgroup_identity(work->expected_cgroup) ||
      work->have_expected_executable_identity == 0) {
    (void)close(peer_pidfd);
    set_error(work, "ctxlane peer executable and cgroup attestation are required");
    return -1;
  }
  if (snprintf(proc_path, sizeof(proc_path), "/proc/%ld/exe", (long)peer.pid) >=
      (int)sizeof(proc_path)) {
    (void)close(peer_pidfd);
    set_error(work, "ctxlane peer executable path is too long");
    return -1;
  }
  executable_len = readlink(proc_path, executable, sizeof(executable) - 1);
  if (executable_len < 0 || (size_t)executable_len >= sizeof(executable)) {
    (void)close(peer_pidfd);
    set_error(work, "ctxlane peer executable could not be attested");
    return -1;
  }
  executable[executable_len] = '\0';
  if (strcmp(executable, work->expected_executable) != 0) {
    (void)close(peer_pidfd);
    set_error(work, "ctxlane peer executable does not match policy");
    return -1;
  }
  if (stat(proc_path, &executable_stat) != 0 ||
      !same_file_identity(&work->expected_executable_stat, &executable_stat) ||
      hash_path(proc_path, executable_digest) != 0 ||
      memcmp(work->expected_executable_digest, executable_digest,
             sizeof(executable_digest)) != 0) {
    (void)close(peer_pidfd);
    set_error(work, "ctxlane peer executable identity does not match policy");
    return -1;
  }
  if (snprintf(proc_path, sizeof(proc_path), "/proc/%ld/cgroup", (long)peer.pid) >=
      (int)sizeof(proc_path) || read_text_file(proc_path, cgroup, sizeof(cgroup)) != 0) {
    (void)close(peer_pidfd);
    set_error(work, "ctxlane peer cgroup could not be attested");
    return -1;
  }
  if (strcmp(cgroup, work->expected_cgroup) != 0) {
    (void)close(peer_pidfd);
    set_error(work, "ctxlane peer cgroup does not match policy");
    return -1;
  }
  *peer_out = peer;
  *peer_pidfd_out = peer_pidfd;
  return 0;
}

static int snapshot_endpoint(const exchange_work *work, struct stat *socket_stat,
                             struct stat *directory_stat) {
  char directory[sizeof(((struct sockaddr_un *)0)->sun_path)];
  char *slash;
  char ancestor[sizeof(directory)];
  struct stat socket_info;
  struct stat directory_info;

  if (work->path_len == 0 || work->path_len > MAX_UNIX_PATH_BYTES) return -1;
  if (snprintf(directory, sizeof(directory), "%s", work->path) >= (int)sizeof(directory))
    return -1;
  slash = strrchr(directory, '/');
  if (slash == NULL) return -1;
  if (slash == directory) {
    (void)snprintf(directory, sizeof(directory), "/");
  } else {
    *slash = '\0';
  }
  if (lstat(work->path, &socket_info) != 0 || !S_ISSOCK(socket_info.st_mode)) return -1;
  if (lstat(directory, &directory_info) != 0 || !S_ISDIR(directory_info.st_mode)) return -1;
  if ((socket_info.st_mode & 0777) != 0600 || (directory_info.st_mode & 0022) != 0)
    return -1;
  if (!trusted_uid(work, socket_info.st_uid) || !trusted_uid(work, directory_info.st_uid)) return -1;
  (void)snprintf(ancestor, sizeof(ancestor), "%s", directory);
  for (;;) {
    struct stat ancestor_info;
    char *parent;
    if (lstat(ancestor, &ancestor_info) != 0 || !S_ISDIR(ancestor_info.st_mode) ||
        (ancestor_info.st_mode & 0022) != 0 || !trusted_uid(work, ancestor_info.st_uid))
      return -1;
    if (strcmp(ancestor, "/") == 0) break;
    parent = strrchr(ancestor, '/');
    if (parent == NULL) return -1;
    if (parent == ancestor) {
      (void)snprintf(ancestor, sizeof(ancestor), "/");
    } else {
      *parent = '\0';
    }
  }
  *socket_stat = socket_info;
  *directory_stat = directory_info;
  return 0;
}

static int make_timeout(uint32_t timeout_ms, struct timeval *value) {
  value->tv_sec = (time_t)(timeout_ms / 1000U);
  value->tv_usec = (suseconds_t)((timeout_ms % 1000U) * 1000U);
  return 0;
}

static int exchange_record(exchange_work *work) {
  int fd = -1;
  int peer_pidfd = -1;
  int passcred = 1;
  socklen_t passcred_len = sizeof(passcred);
  struct sockaddr_un address;
  struct stat socket_before;
  struct stat directory_before;
  struct stat socket_after;
  struct stat directory_after;
  struct timeval timeout;
  struct iovec request_iov;
  struct msghdr request_message;
  struct iovec response_iov;
  struct msghdr response_message;
  char *control = NULL;
  struct ucred received_cred;
  struct ucred peer_cred;
  int have_received_cred = 0;
  ssize_t sent;
  ssize_t received;

  if (snapshot_endpoint(work, &socket_before, &directory_before) != 0) {
    set_error(work, "ctxlane control endpoint is not a private socket");
    return -1;
  }
  if (snapshot_expected_executable(work) != 0) {
    set_error(work, "ctxlane configured peer executable is not a protected file");
    return -1;
  }
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  (void)memcpy(address.sun_path, work->path, work->path_len + 1);
  fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    set_error(work, "ctxlane SOCK_SEQPACKET is unavailable");
    return -1;
  }
  if (setsockopt(fd, SOL_SOCKET, SO_PASSCRED, &passcred, sizeof(passcred)) != 0 ||
      getsockopt(fd, SOL_SOCKET, SO_PASSCRED, &passcred, &passcred_len) != 0 ||
      passcred_len != sizeof(passcred) || passcred != 1 ||
      make_timeout(work->timeout_ms, &timeout) != 0 ||
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0 ||
      setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) != 0) {
    set_error(work, "ctxlane socket policy could not be applied");
    goto fail;
  }
  if (connect(fd, (struct sockaddr *)&address,
              (socklen_t)(offsetof(struct sockaddr_un, sun_path) + work->path_len + 1)) != 0) {
    set_error(work, "ctxlane control connection failed");
    goto fail;
  }
  if (snapshot_endpoint(work, &socket_after, &directory_after) != 0 ||
      !same_stat(&socket_before, &socket_after) ||
      !same_stat(&directory_before, &directory_after)) {
    set_error(work, "ctxlane control endpoint changed before exchange");
    goto fail;
  }
  if (attest_peer(work, fd, &peer_cred, &peer_pidfd) != 0) goto fail;

  memset(&request_message, 0, sizeof(request_message));
  request_iov.iov_base = work->request;
  request_iov.iov_len = work->request_len;
  request_message.msg_iov = &request_iov;
  request_message.msg_iovlen = 1;
  sent = sendmsg(fd, &request_message, MSG_NOSIGNAL);
  if (sent != (ssize_t)work->request_len) {
    set_error(work, "ctxlane request was not one complete record");
    goto fail;
  }

  work->response = (uint8_t *)malloc(work->max_message_bytes);
  control = (char *)calloc(1, ANCILLARY_BUFFER_BYTES);
  if (work->response == NULL || control == NULL) {
    set_error(work, "ctxlane response allocation failed");
    goto fail;
  }
  memset(&response_message, 0, sizeof(response_message));
  response_iov.iov_base = work->response;
  response_iov.iov_len = work->max_message_bytes;
  response_message.msg_iov = &response_iov;
  response_message.msg_iovlen = 1;
  response_message.msg_control = control;
  response_message.msg_controllen = ANCILLARY_BUFFER_BYTES;
  received = recvmsg(fd, &response_message, 0);
  if (received < 0) {
    set_error(work, "ctxlane response receive failed");
    goto fail;
  }
  if ((response_message.msg_flags & MSG_TRUNC) != 0 ||
      received <= 0 || (size_t)received > work->max_message_bytes) {
    set_error(work, "ctxlane response exceeded the one-record limit");
    goto fail;
  }
  {
    struct cmsghdr *header;
    int ancillary_error = 0;
    for (header = CMSG_FIRSTHDR(&response_message); header != NULL;
         header = CMSG_NXTHDR(&response_message, header)) {
      if (header->cmsg_len < CMSG_LEN(0)) {
        ancillary_error = 1;
        continue;
      }
      if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_CREDENTIALS) {
        if (header->cmsg_len != CMSG_LEN(sizeof(struct ucred)) || have_received_cred) {
          ancillary_error = 1;
          continue;
        }
        (void)memcpy(&received_cred, CMSG_DATA(header), sizeof(received_cred));
        have_received_cred = 1;
      } else if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS) {
        size_t payload_bytes;
        size_t descriptor_count;
        size_t descriptor_index;
        payload_bytes = header->cmsg_len - CMSG_LEN(0);
        descriptor_count = payload_bytes / sizeof(int);
        for (descriptor_index = 0; descriptor_index < descriptor_count;
             ++descriptor_index) {
          int received_fd;
          (void)memcpy(&received_fd,
                       (const char *)CMSG_DATA(header) + descriptor_index * sizeof(int),
                       sizeof(received_fd));
          if (received_fd >= 0) (void)close(received_fd);
        }
        ancillary_error = 1;
      } else {
        ancillary_error = 1;
      }
    }
    if (ancillary_error != 0 || (response_message.msg_flags & MSG_CTRUNC) != 0) {
      set_error(work, "ctxlane response contains unexpected ancillary data");
      goto fail;
    }
  }
  if (!have_received_cred || received_cred.pid != peer_cred.pid ||
      received_cred.uid != peer_cred.uid || received_cred.gid != peer_cred.gid ||
      !trusted_uid(work, received_cred.uid)) {
    set_error(work, "ctxlane response credentials are not bound");
    goto fail;
  }
  {
    struct pollfd peer_poll;
    struct ucred rechecked_peer;
    int rechecked_pidfd = -1;
    int poll_result;
    memset(&peer_poll, 0, sizeof(peer_poll));
    peer_poll.fd = peer_pidfd;
    peer_poll.events = POLLIN;
    poll_result = poll(&peer_poll, 1, 0);
    if (poll_result < 0 || (poll_result > 0 && peer_poll.revents != 0) ||
        attest_peer(work, fd, &rechecked_peer, &rechecked_pidfd) != 0 ||
        rechecked_peer.pid != peer_cred.pid || rechecked_peer.uid != peer_cred.uid ||
        rechecked_peer.gid != peer_cred.gid) {
      if (rechecked_pidfd >= 0) (void)close(rechecked_pidfd);
      set_error(work, "ctxlane peer changed during exchange");
      goto fail;
    }
    (void)close(rechecked_pidfd);
  }
  work->response_len = (size_t)received;
  free(control);
  (void)close(peer_pidfd);
  peer_pidfd = -1;
  (void)close(fd);
  return 0;

fail:
  free(control);
  free(work->response);
  work->response = NULL;
  if (peer_pidfd >= 0) (void)close(peer_pidfd);
  if (fd >= 0) (void)close(fd);
  return -1;
}

static void execute_exchange(napi_env env, void *data) {
  exchange_work *work = (exchange_work *)data;
  (void)env;
  if (exchange_record(work) != 0 && work->status == 0)
    set_error(work, "ctxlane native exchange failed");
}

static void complete_exchange(napi_env env, napi_status status, void *data) {
  exchange_work *work = (exchange_work *)data;
  napi_value result;
  napi_value error;
  if (status != napi_ok && work->status == 0) set_error(work, "ctxlane native work cancelled");
  if (work->status != 0) {
    if (napi_create_string_utf8(env, work->error, NAPI_AUTO_LENGTH, &error) == napi_ok &&
        napi_create_error(env, NULL, error, &error) == napi_ok) {
      (void)napi_reject_deferred(env, work->deferred, error);
    }
  } else if (napi_create_buffer_copy(env, work->response_len, work->response, NULL, &result) != napi_ok) {
    if (napi_create_string_utf8(env, "ctxlane response allocation failed", NAPI_AUTO_LENGTH, &error) == napi_ok &&
        napi_create_error(env, NULL, error, &error) == napi_ok) {
      (void)napi_reject_deferred(env, work->deferred, error);
    }
  } else {
    napi_resolve_deferred(env, work->deferred, result);
  }
  (void)napi_delete_async_work(env, work->work);
  free(work->path);
  free(work->request);
  free(work->trusted_uids);
  free(work->expected_executable);
  free(work->expected_cgroup);
  free(work->response);
  free(work);
}

/* The only exported operation is one bounded native record exchange. */
static napi_value exchange(napi_env env, napi_callback_info info) {
  napi_value args[8];
  size_t argc = 8;
  exchange_work *work;
  napi_value promise;
  bool is_array;
  uint32_t max_message;
  uint32_t timeout_ms;
  size_t path_len;
  size_t executable_len;
  size_t cgroup_len;
  void *request_data;
  size_t request_len;
  uint32_t owner_count;
  uint32_t i;
  napi_value resource_name;
  napi_status napi_result;

  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 7 ||
      napi_get_value_string_utf8(env, args[0], NULL, 0, &path_len) != napi_ok ||
      napi_get_buffer_info(env, args[1], &request_data, &request_len) != napi_ok ||
      napi_get_value_uint32(env, args[2], &max_message) != napi_ok ||
      napi_get_value_uint32(env, args[3], &timeout_ms) != napi_ok ||
      napi_get_value_string_utf8(env, args[4], NULL, 0, &executable_len) != napi_ok ||
      napi_get_value_string_utf8(env, args[5], NULL, 0, &cgroup_len) != napi_ok ||
      napi_is_array(env, args[6], &is_array) != napi_ok || !is_array ||
      napi_get_array_length(env, args[6], &owner_count) != napi_ok) {
    napi_throw_type_error(env, NULL, "ctxlane native exchange arguments are invalid");
    return NULL;
  }
  if (path_len == 0 || path_len > MAX_UNIX_PATH_BYTES || request_len == 0 ||
      max_message < 1024 || request_len > max_message || max_message > 256U * 1024U ||
      timeout_ms == 0 || timeout_ms > 30000U || executable_len == 0 ||
      executable_len >= PATH_MAX || cgroup_len == 0 || cgroup_len >= MAX_PEER_TEXT_BYTES ||
      owner_count == 0) {
    napi_throw_range_error(env, NULL, "ctxlane native exchange arguments are outside safe bounds");
    return NULL;
  }
  work = (exchange_work *)calloc(1, sizeof(*work));
  if (work == NULL) {
    napi_throw_error(env, NULL, "ctxlane native exchange allocation failed");
    return NULL;
  }
  work->path = (char *)calloc(path_len + 1, 1);
  work->request = (uint8_t *)malloc(request_len);
  work->trusted_uids = (uid_t *)calloc(owner_count, sizeof(uid_t));
  work->expected_executable = (char *)calloc(executable_len + 1, 1);
  work->expected_cgroup = (char *)calloc(cgroup_len + 1, 1);
  if (work->path == NULL || work->request == NULL || work->trusted_uids == NULL ||
      work->expected_executable == NULL || work->expected_cgroup == NULL ||
      napi_get_value_string_utf8(env, args[0], work->path, path_len + 1, &path_len) != napi_ok ||
      napi_get_value_string_utf8(env, args[4], work->expected_executable, executable_len + 1,
                                  &executable_len) != napi_ok ||
      napi_get_value_string_utf8(env, args[5], work->expected_cgroup, cgroup_len + 1,
                                  &cgroup_len) != napi_ok) {
    free(work->path);
    free(work->request);
    free(work->trusted_uids);
    free(work->expected_executable);
    free(work->expected_cgroup);
    free(work);
    napi_throw_error(env, NULL, "ctxlane native exchange argument copy failed");
    return NULL;
  }
  (void)memcpy(work->request, request_data, request_len);
  work->path_len = path_len;
  work->request_len = request_len;
  work->max_message_bytes = max_message;
  work->timeout_ms = timeout_ms;
  work->trusted_uid_count = owner_count;
  for (i = 0; i < owner_count; ++i) {
    napi_value item;
    uint32_t uid;
    if (napi_get_element(env, args[6], i, &item) != napi_ok ||
        napi_get_value_uint32(env, item, &uid) != napi_ok || uid > UINT_MAX) {
      free(work->path);
      free(work->request);
      free(work->trusted_uids);
      free(work->expected_executable);
      free(work->expected_cgroup);
      free(work);
      napi_throw_type_error(env, NULL, "ctxlane native owner set is invalid");
      return NULL;
    }
    work->trusted_uids[i] = (uid_t)uid;
  }
  if (snapshot_expected_executable(work) != 0) {
    free(work->path);
    free(work->request);
    free(work->trusted_uids);
    free(work->expected_executable);
    free(work->expected_cgroup);
    free(work);
    napi_throw_error(env, NULL, "ctxlane expected peer executable is not a private executable");
    return NULL;
  }
  napi_result = napi_create_promise(env, &work->deferred, &promise);
  if (napi_result != napi_ok ||
      napi_create_string_utf8(env, "ctxlane native seqpacket exchange", NAPI_AUTO_LENGTH,
                              &resource_name) != napi_ok ||
      napi_create_async_work(env, NULL, resource_name, execute_exchange, complete_exchange,
                             work, &work->work) != napi_ok) {
    free(work->path);
    free(work->request);
    free(work->trusted_uids);
    free(work->expected_executable);
    free(work->expected_cgroup);
    free(work);
    napi_throw_error(env, NULL, "ctxlane native exchange could not be queued");
    return NULL;
  }
  if (napi_queue_async_work(env, work->work) != napi_ok) {
    (void)napi_delete_async_work(env, work->work);
    free(work->path);
    free(work->request);
    free(work->trusted_uids);
    free(work->expected_executable);
    free(work->expected_cgroup);
    free(work);
    napi_throw_error(env, NULL, "ctxlane native exchange could not be queued");
    return NULL;
  }
  return promise;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  if (napi_create_function(env, "exchange", NAPI_AUTO_LENGTH, exchange, NULL, &fn) != napi_ok ||
      napi_set_named_property(env, exports, "exchange", fn) != napi_ok) {
    return NULL;
  }
  return exports;
}

#else

NAPI_MODULE_INIT() {
  (void)env;
  return exports;
}

#endif
