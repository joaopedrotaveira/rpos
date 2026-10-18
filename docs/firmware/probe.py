#!/usr/bin/env python3
"""Send rposascii lines to a PTZ controller and print what comes back.

  probe.py tcp://192.168.1.50:9999 'getcaps' 'getstatus'
  probe.py /dev/ttyACM0 'relative-ptz\t0.1\t0\t0\tspace=fov'    (needs: pip install pyserial)

Each argument is one line. \\t in an argument becomes a TAB. Listens for --listen seconds
after the last line (default 2) and prints every line received with a time stamp.
"""
import argparse, socket, sys, time

def open_link(target):
    if target.startswith('tcp://'):
        host, port = target[6:].rsplit(':', 1)
        s = socket.create_connection((host, int(port)), timeout=5)
        s.settimeout(0.05)
        return (lambda data: s.sendall(data)), (lambda: s.recv(4096))
    import serial  # pip install pyserial
    p = serial.Serial(target, 115200, timeout=0.05)
    return (lambda data: p.write(data)), (lambda: p.read(4096))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('target')
    ap.add_argument('lines', nargs='*')
    ap.add_argument('--listen', type=float, default=2.0)
    ap.add_argument('--gap', type=float, default=0.2, help='seconds between lines')
    a = ap.parse_args()
    write, read = open_link(a.target)
    start = time.time()
    buf = b''
    def pump(seconds):
        nonlocal buf
        end = time.time() + seconds
        while time.time() < end:
            try:
                chunk = read()
            except socket.timeout:
                chunk = b''
            buf += chunk
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                print('%7.3f  <- %s' % (time.time() - start, line.decode('utf-8', 'replace').rstrip('\r').replace('\t', '<TAB>')))
    pump(0.3)   # anything the controller sends on connect
    for text in a.lines:
        line = text.replace('\\t', '\t') + '\n'
        print('%7.3f  -> %s' % (time.time() - start, text))
        write(line.encode('utf-8'))
        pump(a.gap)
    pump(a.listen)

main()
