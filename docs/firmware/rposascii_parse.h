// rposascii v2 line parser. Plain C++, no Arduino dependencies, no heap.
#pragma once
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>

struct KeyValue { const char* key; const char* value; };

struct Message {
  const char* command;
  const char* pos[3];          // positional fields (at most 3)
  uint8_t npos;
  KeyValue keys[8];            // key=value fields after the positional ones
  uint8_t nkeys;
};

// How many positional fields each command carries. Everything after them is a key=value field.
// A preset name may be empty or contain '=', so the position, not the text, decides what a token is.
static inline int positionalCount(const char* command) {
  if (!strcmp(command, "ptz") || !strcmp(command, "absolute-ptz") || !strcmp(command, "relative-ptz")) return 3;
  if (!strcmp(command, "gotopreset") || !strcmp(command, "setpreset") || !strcmp(command, "clearpreset")) return 2;
  return 0;
}

// Splits `line` in place (it is modified). Returns false if the message must be ignored:
// empty line, or fewer positional fields than the command needs.
static inline bool parseLine(char* line, Message& m) {
  size_t n = strlen(line);
  while (n > 0 && (line[n - 1] == '\r' || line[n - 1] == '\n')) line[--n] = 0;
  if (n == 0) return false;

  char* rest = line;
  m.command = strsep(&rest, "\t");        // strsep keeps empty fields, strtok does not
  m.npos = 0;
  m.nkeys = 0;
  const int want = positionalCount(m.command);

  char* token;
  while ((token = strsep(&rest, "\t")) != nullptr) {
    if (m.npos < want) {
      m.pos[m.npos++] = token;
      continue;
    }
    char* eq = strchr(token, '=');
    if (eq == nullptr) continue;          // not a key=value field: ignore it
    if (m.nkeys < 8) {
      *eq = 0;
      m.keys[m.nkeys].key = token;
      m.keys[m.nkeys].value = eq + 1;
      m.nkeys++;
    }
  }
  return m.npos == want;
}

static inline const char* keyValue(const Message& m, const char* key) {
  for (uint8_t i = 0; i < m.nkeys; i++) {
    if (!strcmp(m.keys[i].key, key)) return m.keys[i].value;
  }
  return nullptr;
}

// Number from text, or `fallback` if it is missing, malformed or not finite.
static inline float toFloat(const char* text, float fallback) {
  if (text == nullptr || *text == 0) return fallback;
  char* end;
  float f = strtof(text, &end);
  if (end == text || !isfinite(f)) return fallback;
  return f;
}
