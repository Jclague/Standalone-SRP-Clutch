#include <stdint.h>
#include <stddef.h>

struct __attribute__((packed)) status_packet_t {
  uint8_t id;
  uint16_t raw;
  float norm;
  int16_t ax;
  uint16_t cal_min;
  uint16_t cal_max;
  uint16_t polling_rate_hz;
  uint8_t is_calibrating;
  uint8_t fw_major;
  uint8_t fw_minor;
  uint8_t fw_patch;
};

_Static_assert(sizeof(struct status_packet_t) == 19, "Size must be 19");
_Static_assert(offsetof(struct status_packet_t, id) == 0, "id offset");
_Static_assert(offsetof(struct status_packet_t, raw) == 1, "raw offset");
_Static_assert(offsetof(struct status_packet_t, norm) == 3, "norm offset");
_Static_assert(offsetof(struct status_packet_t, ax) == 7, "ax offset");
_Static_assert(offsetof(struct status_packet_t, cal_min) == 9, "cal_min offset");
_Static_assert(offsetof(struct status_packet_t, cal_max) == 11, "cal_max offset");
_Static_assert(offsetof(struct status_packet_t, polling_rate_hz) == 13, "polling_rate_hz offset");
_Static_assert(offsetof(struct status_packet_t, is_calibrating) == 15, "is_calibrating offset");
_Static_assert(offsetof(struct status_packet_t, fw_major) == 16, "fw_major offset");
_Static_assert(offsetof(struct status_packet_t, fw_minor) == 17, "fw_minor offset");
_Static_assert(offsetof(struct status_packet_t, fw_patch) == 18, "fw_patch offset");

int main(void) {
    return 0;
}
