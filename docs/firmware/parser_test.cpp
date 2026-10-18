#include "rposascii_parse.h"
#include <assert.h>
#include <stdio.h>
#include <string>

static Message parse(const char* text, bool expect = true) {
  static char buf[300];
  strncpy(buf, text, sizeof(buf) - 1); buf[sizeof(buf) - 1] = 0;
  Message m;
  bool ok = parseLine(buf, m);
  assert(ok == expect);
  return m;
}

int main() {
  Message m = parse("relative-ptz\t0.1\t-0.05\t0\tcam=1\tspace=fov\tpanspeed=0.5\r\n");
  assert(!strcmp(m.command, "relative-ptz"));
  assert(toFloat(m.pos[0], 9) == 0.1f && toFloat(m.pos[1], 9) == -0.05f && toFloat(m.pos[2], 9) == 0);
  assert(!strcmp(keyValue(m, "space"), "fov"));
  assert(toFloat(keyValue(m, "panspeed"), -1) == 0.5f);
  assert(keyValue(m, "tiltspeed") == nullptr);
  assert(toFloat(keyValue(m, "tiltspeed"), 0.7f) == 0.7f);

  // an empty preset name must not shift the preset value
  m = parse("setpreset\t\t3\tcam=1");
  assert(!strcmp(m.pos[0], "") && !strcmp(m.pos[1], "3"));
  // a preset name that looks like a key
  m = parse("gotopreset\tx=1\t7");
  assert(!strcmp(m.pos[0], "x=1") && !strcmp(m.pos[1], "7") && m.nkeys == 0);
  // too few positional fields: ignored
  parse("ptz\t0.5", false);
  parse("setpreset\tonly", false);
  parse("", false);
  parse("\r\n", false);
  // no positional fields; keys in any order; unknown keys are kept and can be skipped
  m = parse("stop\tfoo=bar\tpantilt=1\tcam=2");
  assert(m.npos == 0 && !strcmp(keyValue(m, "pantilt"), "1") && !strcmp(keyValue(m, "cam"), "2"));
  m = parse("getstatus");
  assert(!strcmp(m.command, "getstatus") && m.nkeys == 0);
  // unknown command parses (the dispatcher ignores it)
  m = parse("somethingnew\ta\tb\tk=v");
  assert(!strcmp(m.command, "somethingnew") && m.npos == 0 && !strcmp(keyValue(m, "k"), "v"));
  // numbers
  assert(toFloat("abc", 5) == 5 && toFloat("", 5) == 5 && toFloat(nullptr, 5) == 5);
  assert(toFloat("nan", 5) == 5 && toFloat("inf", 5) == 5);
  assert(toFloat("1e-3", 5) == 0.001f);
  assert(toFloat("-1", 5) == -1);
  // more than 8 keys: the extra ones are dropped, nothing overflows
  m = parse("stop\ta=1\tb=1\tc=1\td=1\te=1\tf=1\tg=1\th=1\ti=1\tj=1");
  assert(m.nkeys == 8);
  puts("parser ok");
  return 0;
}
