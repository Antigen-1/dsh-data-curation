#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>
#include <dirent.h>

#include <emscripten.h>

#include "scheme.h"

/*
 * Small synchronous C ABI around a long-lived Chez heap.
 *
 * dsh_init() boots Chez from the preloaded boot images and loads the guest
 * program. dsh_dispatch() passes one request payload to the guest's
 * dsh-dispatch procedure and exposes the returned bytevector through
 * dsh_out_ptr()/dsh_out_len(). The host owns the input buffer.
 */

#define DSH_MAX_OUTPUT_BYTES 1000000

static int initialized = 0;
static unsigned char *out_buf = NULL;
static size_t out_cap = 0;
static size_t out_len = 0;
static char guest_path[256] = "/online-vm-c.scm";

static int safe_path(const char *path) {
  const char *p;

  if (path == NULL || path[0] != '/' || path[1] == '\0') return 0;
  if (strstr(path, "..") != NULL || strstr(path, "//") != NULL) return 0;
  for (p = path; *p != '\0'; p++) {
    if (*p == '\\') return 0;
  }
  return 1;
}

static int make_dirs(const char *path) {
  char tmp[512];
  size_t n = strlen(path);
  size_t i;

  if (n == 0 || n >= sizeof(tmp)) return -1;
  memcpy(tmp, path, n + 1);
  for (i = 1; i < n; i++) {
    if (tmp[i] == '/') {
      tmp[i] = '\0';
      if (mkdir(tmp, 0755) != 0 && errno != EEXIST) return -1;
      tmp[i] = '/';
    }
  }
  return 0;
}

int dsh_set_guest(const char *path) {
  if (!safe_path(path) || strstr(path, ".scm") == NULL) return -1;
  if (strlen(path) >= sizeof(guest_path)) return -1;
  strcpy(guest_path, path);
  return 0;
}

int dsh_mount_file(const char *path, const char *data, int len, int readonly) {
  FILE *f;
  size_t n;

  if (!safe_path(path) || strncmp(path, "/project/", 9) != 0) return -2;
  if (len < 0 || data == NULL) return -3;
  if (make_dirs(path) != 0) return -4;
  f = fopen(path, "wb");
  if (f == NULL) return -5;
  n = fwrite(data, 1, (size_t)len, f);
  if (fclose(f) != 0 || n != (size_t)len) return -6;
  if (readonly && chmod(path, 0444) != 0) return -7;
  return 0;
}

int dsh_read_file(const char *path, char *buf, int cap) {
  FILE *f;
  size_t n;

  if (!safe_path(path) || cap < 0 || buf == NULL) return -1;
  f = fopen(path, "rb");
  if (f == NULL) return -2;
  n = fread(buf, 1, (size_t)cap, f);
  fclose(f);
  return n > (size_t)INT_MAX ? -1 : (int)n;
}

int dsh_file_size(const char *path) {
  struct stat st;
  if (!safe_path(path)) return -1;
  if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) return -2;
  return st.st_size > INT_MAX ? -1 : (int)st.st_size;
}

int dsh_out_count(void) {
  DIR *dir;
  struct dirent *entry;
  int count = 0;

  dir = opendir("/out");
  if (dir == NULL) return 0;
  while ((entry = readdir(dir)) != NULL) {
    if (entry->d_name[0] == '.') continue;
    count++;
  }
  closedir(dir);
  return count;
}

int dsh_out_size(void) {
  DIR *dir;
  struct dirent *entry;
  long total = 0;

  dir = opendir("/out");
  if (dir == NULL) return 0;
  while ((entry = readdir(dir)) != NULL) {
    char path[512];
    struct stat st;
    if (entry->d_name[0] == '.') continue;
    if (snprintf(path, sizeof(path), "/out/%s", entry->d_name) >= (int)sizeof(path)) {
      closedir(dir);
      return -1;
    }
    if (stat(path, &st) == 0 && S_ISREG(st.st_mode)) total += (long)st.st_size;
  }
  closedir(dir);
  return total > INT_MAX ? -1 : (int)total;
}

static void dsh_abort(void) {
  abort();
}

static void dsh_fatal(const char *message) {
  fprintf(stderr, "dsh-online-vm: %s\n", message);
  abort();
}

int dsh_init(void) {
  ptr load_proc;

  if (initialized) return 0;

  (void)mkdir("/out", 0755);
  Sscheme_init(dsh_abort);
  Sregister_boot_file("/petite.boot");
  Sregister_boot_file("/scheme.boot");
  Sbuild_heap(NULL, NULL);

  load_proc = Stop_level_value(Sstring_to_symbol("load"));
  if (!Sprocedurep(load_proc)) dsh_fatal("load is not bound");
  (void)Scall1(load_proc, Sstring_utf8(guest_path, -1));

  if (!Sprocedurep(Stop_level_value(Sstring_to_symbol("dsh-dispatch"))))
    dsh_fatal("dsh-dispatch is not defined by the guest");

  initialized = 1;
  return 0;
}

static int call_guest(const char *name, const char *payload, int payload_len) {
  ptr proc, arg, result;
  iptr n;

  if (payload_len < 0) return -1;
  if (!initialized && dsh_init() != 0) return -1;

  proc = Stop_level_value(Sstring_to_symbol(name));
  if (!Sprocedurep(proc)) {
    fprintf(stderr, "dsh-online-vm: %s is not bound\n", name);
    return -1;
  }

  arg = Sstring_utf8(payload, (iptr)payload_len);
  result = Scall1(proc, arg);
  if (!Sbytevectorp(result)) {
    fprintf(stderr, "dsh-online-vm: %s did not return a bytevector\n", name);
    return -1;
  }

  n = Sbytevector_length(result);
  if (n < 0 || (uint64_t)n > (uint64_t)SIZE_MAX) return -1;
  if ((uint64_t)n > (uint64_t)DSH_MAX_OUTPUT_BYTES) return -2;
  if ((size_t)n > out_cap) {
    unsigned char *next = (unsigned char *)realloc(out_buf, (size_t)n);
    if (next == NULL) return -1;
    out_buf = next;
    out_cap = (size_t)n;
  }
  if (n > 0) memcpy(out_buf, Sbytevector_data(result), (size_t)n);
  out_len = (size_t)n;
  return 0;
}

int dsh_dispatch(const char *payload, int payload_len) {
  return call_guest("dsh-dispatch", payload, payload_len);
}

int dsh_resume(const char *payload, int payload_len) {
  return call_guest("dsh-resume", payload, payload_len);
}

unsigned char *dsh_out_ptr(void) {
  return out_buf;
}

int dsh_out_len(void) {
  return out_len > (size_t)INT_MAX ? -1 : (int)out_len;
}
