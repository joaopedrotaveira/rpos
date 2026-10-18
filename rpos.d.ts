///<reference path="./lib/extension.ts"/>
interface rposConfig {
  NetworkAdapters: string[];
  IpAddress: string;
  ServicePort: number;
  Username: string;
  Password: string;
  Cameras: CameraSettings[];
  CameraName: string;
  CameraType: string;
  CameraDevice: string;
  RTSPAddress: string;
  RTSPPort: number;
  RTSPName: string;
  RTSPServer: number;
  MulticastEnabled: boolean;
  RTSPMulticastName : string;
  MulticastAddress: string;
  MulticastPort: number;
  PTZDriver: string;
  PTZOutput: string;
  PTZSerialPort: string;
  PTZSerialPortSettings: PTZSerialPortSettings;
  PTZOutputURL: string;
  PTZCameraAddress: number;
  PTZNumPresets: number;
  PTZStatusMode?: string;         // rposascii: auto, controller, estimate or off
  PTZStatusMaxAgeMs?: number;     // rposascii: age up to which a cached status is used
  PTZRequestTimeoutMs?: number;   // rposascii: how long to wait for the controller to reply
  PTZEstimateMsPerUnit?: number;  // rposascii: estimated time for a move of 1.0 (normalised)
  PTZHorizontalFOV?: number;      // degrees, used if the controller does not report it
  PTZVerticalFOV?: number;
  DeviceInformation: DeviceInformation;
  logLevel: number;
  logSoapCalls: Boolean;
}

interface CameraSettings {
  CameraName: string;
  CameraType: string;
  CameraDevice: string;
  RTSPAddress: string;
  RTSPPort: number;
  RTSPName: string;
  RTSPServer: number;
  MulticastEnabled: boolean;
  RTSPMulticastName: string;
  MulticastAddress: string;
  MulticastPort: number;
  PTZCameraAddress: number; // There is currently one global PTZ output. This defines the camera number
}

interface PTZSerialPortSettings {
  baudRate: number;
  dataBits: number;
  parity: string;
  stopBits: number;
}

interface DeviceInformation {
  Manufacturer: string;
  Model: string;
  HardwareId: string;
  SerialNumber: string;
  FirmwareVersion: string;
}

interface TypeConstructor extends Function {
  name: string;
}

interface SoapServiceOptions {
  path: string,
  services: any,
  xml: any,
  wsdlPath: string,
  onReady: () => void;
}

interface Date {
  stdTimezoneOffset: () => number;
  dst: () => boolean;
}

interface UserControlOptions<T> {
  stringify?: (T) => string,
  range?: {
    min: T,
    max: T,
    allowZero?: boolean,
    step?: T
  }
  lookupSet?: UserControlsLookupSet<T>;
}

interface UserControlsLookup<T> {
  value: T;
  desc: string;
}
interface UserControlsLookupSet<T> extends Array<UserControlsLookup<T>> {

}

interface Resolution {
  Width: number;
  Height: number;
}
interface CameraSettingsParameter {
  gop: number; //keyframe every X sec.
  resolution: Resolution;
  framerate: number;
  bitrate: number;
  profile: string;
  quality: number;
}
interface CameraSettingsBase {
  forceGop: boolean; // Use iframe interval setting from v4l2ctl.json instead of Onvif
  resolution: Resolution;
  framerate: number;
}

type VideoSource = {
  attributes: {
    token: string
  },
  Framerate: number,
  Resolution: {
    Width: number,
    Height: number
  }
}

type VideoSourceConfiguration = {
  Name: string
  attributes: {
    token: string
  },
  UseCount: number,
  SourceToken: string,
  Bounds: {
    attributes: {
      x: number,
      y: number,
      width: number,
      height: number
    }
  }
}

type SavedProfile = {
  name: string,
  token: string,
  videoSourceConfigurationToken: string,
  videoEncoderConfigurationToken: string,
  ptzConfigurationToken: string
}

type Profile = {
  Name: string
  attributes: {
    token: string,
    fixed: boolean
  },
  VideoSourceConfiguration?: VideoSourceConfiguration,
  VideoEncoderConfiguration?: any,
  PTZConfiguration?: any
};

type PresetArrayItem = {
  ptzNodeToken: string,
  presetName: string,
  presetToken: string,
  used: boolean,
  fixed: boolean
};

type ImagingArrayItem = {
  videoSourceToken: string,
  brightness: number,
  autoFocusMode: string,
  focusDefaultSpeed: number,
  focusNearLimit: number,
  focusFarLimit: number
};

interface PTZStatusInfo {
  pan?: number;        // -1..1, only when the position is real
  tilt?: number;
  zoom?: number;
  panTilt: 'IDLE' | 'MOVING' | 'UNKNOWN';
  error?: string;
  estimated: boolean;  // true when rpos made the status up from its own commands
}
