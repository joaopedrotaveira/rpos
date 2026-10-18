#!/bin/sh
echo $@

# Ubuntu 21 installs Python3 by default and appears to have dropped the Python 2 'Gi' package that
# is required for Gstreamer GObject Introspection

camera-streamer --camera-type=libcamera \
	--camera-nbufs=3 \
	--camera-fps=25 --camera-stream.disabled=0--camera-video.disabled=0 \
	--http-listen=0.0.0.0 \
	--http-port=8082 \
	--http-maxcons=10 \
	--rtsp-port=8554 \
	--webrtc-disable_client_ice=0 \
	--log-debug=0 \
	--log-verbose=0 \
	--log-stats=0

#FILE=/usr/bin/python3
#if test -f "$FILE"; then
#    echo "Found /usr/bin/python3"
#    /usr/bin/python3 ./python/gst-rtsp-launch.py $@ -v
#else
#    echo "using /usr/bin/python"
#    /usr/bin/python ./python/gst-rtsp-launch.py $@ -v
#fi

