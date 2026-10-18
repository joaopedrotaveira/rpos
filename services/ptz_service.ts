///<reference path="../rpos.d.ts" />

import fs = require("fs");
import util = require("util");
import os = require('os');
import SoapService = require('../lib/SoapService');
import { Utils }  from '../lib/utils';
import { Server } from 'http';
import PTZDriver = require('../lib/PTZDriver');
import { onvifFault, noProfile, noConfig, noEntity, invalidArgs } from '../lib/onvifFault';
import { PAN_SCALE_DEG, TILT_SCALE_DEG } from '../lib/RposAscii';

var utils = Utils.utils;

const SPACE_PAN_TILT_POSITION = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace';
const SPACE_PAN_TILT_TRANSLATION = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace';
const SPACE_PAN_TILT_TRANSLATION_FOV = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov';
const SPACE_PAN_TILT_VELOCITY = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace';
const SPACE_PAN_TILT_SPEED = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/GenericSpeedSpace';
const SPACE_ZOOM_POSITION = 'http://www.onvif.org/ver10/tptz/ZoomSpaces/PositionGenericSpace';
const SPACE_ZOOM_TRANSLATION = 'http://www.onvif.org/ver10/tptz/ZoomSpaces/TranslationGenericSpace';
const SPACE_ZOOM_VELOCITY = 'http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace';
const SPACE_ZOOM_SPEED = 'http://www.onvif.org/ver10/tptz/ZoomSpaces/ZoomGenericSpeedSpace';

const NODE_TOKEN_PREFIX = 'ptz_node_token_';

// Velocity last sent to a camera by ContinuousMove, so that a command that carries only
// Pan/Tilt or only Zoom keeps the other value (ODM sends them separately).
type ContinuousState = { pan: number, tilt: number, zoom: number, timer: any };

// Parses an xs:duration like PT5S or PT0.5S. Returns milliseconds, or 0 if there is none.
function parseDurationMs(value: any): number {
  if (typeof value !== 'string') return 0;
  const match = /^P(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!match) return 0;
  return (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
}

function num(value: any, fallback: number): number {
  const n = Number(value);
  return isFinite(n) ? n : fallback;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// "true", true and 1 are true. undefined is the fallback.
function flag(value: any, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === '1' || value === 1;
}

class PTZService extends SoapService {
  ptz_service: any;
  callback: any;
  ptz_driver: PTZDriver;
  profilesArray: Profile[];

  presetsFilename = "presets.json";

  presetArray: PresetArrayItem[] = [];

  public ptzConfigurationsArray: any[] = [];

  static parseDurationMs = parseDurationMs;

  private continuous: { [cameraAddress: number]: ContinuousState } = {};

  constructor(config: rposConfig, server: Server, callback, ptz_driver: PTZDriver, profilesArray: Profile[]) {
    super(config, server);

    this.profilesArray = profilesArray;
    this.ptz_service = require('./stubs/ptz_service.js').PTZService;
    this.callback = callback;
    this.ptz_driver = ptz_driver;

    this.serviceOptions = {
      path: '/onvif/ptz_service',
      services: this.ptz_service,
      xml: fs.readFileSync('./wsdl/ptz_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/ptz_service.wsdl',
      onReady: () => console.log('ptz_service started')
    };

    // Load presets, or Create empty presets

    let presetsLoaded = false;
    if (fs.existsSync(this.presetsFilename)) {
      try {
        let buffer = fs.readFileSync(this.presetsFilename);
        this.presetArray = JSON.parse(buffer.toString());
        presetsLoaded = true;
      } catch (err) {
        presetsLoaded = false;
      }
    }

    if (presetsLoaded == false) {

      // Create all the Presets, with used: set to false
      for (let cam_id = 1; cam_id <= this.config.Cameras.length; cam_id++) {

        // Create all the presets.
        // NOTE they are called Preset 1, 2, 3 etc.
        // The actual PTZ driver may store these as Preset 0, 1, 2 on the device (eg VISCA starts at 0)
        // There is a PTZ Node for each camera
        for (let preset_num = 1; preset_num <=  (this.ptz_driver.numPresets); preset_num++) {
          this.presetArray.push(
            {
              ptzNodeToken: 'ptz_node_token_' + cam_id.toString().padStart(2,'0'),
              presetName: '', // Preset ' + preset_num.toString(),
              presetToken: preset_num.toString(),
              used: false,
              fixed: false // RPOS uses 'fixed' to make a preset that cannot be deleted - eg hard coded Preset for Wipe, or Camera Menu Preset 95 on Pelco
            }
          );
        }
      }
      // create the presets file
      this.savePresets();

    }

    // PTZ Configuration takes a PTZ Node and adds some Defaults like the Default Space and the Default Speed
    for (let i = 1; i <= this.config.Cameras.length; i++) {

      let newItem = {
        attributes: {
          token: `ptz_config_token_${i.toString().padStart(2, '0')}`
        },
        Name: `PTZ Configuration ${i.toString()}`,
        UseCount: 1,
        NodeToken: `${NODE_TOKEN_PREFIX}${i.toString().padStart(2, '0')}`,
        DefaultAbsolutePantTiltPositionSpace: SPACE_PAN_TILT_POSITION,
        DefaultAbsoluteZoomPositionSpace: SPACE_ZOOM_POSITION,
        DefaultRelativePanTiltTranslationSpace: SPACE_PAN_TILT_TRANSLATION,
        DefaultRelativeZoomTranslationSpace: SPACE_ZOOM_TRANSLATION,
        DefaultContinuousPanTiltVelocitySpace: SPACE_PAN_TILT_VELOCITY,
        DefaultContinuousZoomVelocitySpace: SPACE_ZOOM_VELOCITY,
        DefaultPTZSpeed: {
          PanTilt : {
            attributes : {
              x : 1.0,
              y : 1.0,
              space : SPACE_PAN_TILT_SPEED
            }
          },
          Zoom : {
            attributes : {
              x : 1,
              space : SPACE_ZOOM_SPEED
            }
          }
        },
        DefaultPTZTimeout : 'PT5S'
      }

      this.ptzConfigurationsArray.push(newItem);
    }

    // A controller can list the presets it holds. Make our list match.
    if (this.ptz_driver.events) {
      this.ptz_driver.events.on('presets', (tokens: string[]) => this.reconcilePresets(tokens));
    }

    this.extendService();
  }

  leftPad(number, targetLength) {
    var output = number + '';
    while (output.length < targetLength) {
        output = '0' + output;
    }
    return output;
  }

  savePresets() {
    try {
      fs.writeFileSync(this.presetsFilename, JSON.stringify(this.presetArray, null, 4));
    } catch (err) {
      // failed to write
      console.log("failed to write presets file");
    }
  }

  // The controller is the authority on which presets exist, because it stores the positions.
  // Presets it has but we do not know are added with a default name, and presets we think
  // exist that it does not have (for example after the controller's flash was wiped) are
  // cleared. The link serves one camera, so every PTZ node is updated.
  reconcilePresets(tokens: string[]) {
    let changed = false;
    for (const item of this.presetArray) {
      const inController = tokens.indexOf(item.presetToken) >= 0;
      if (inController && !item.used) {
        item.used = true;
        if (!item.presetName) item.presetName = 'Preset ' + item.presetToken;
        changed = true;
      } else if (!inController && item.used && !item.fixed) {
        item.used = false;
        item.presetName = '';
        changed = true;
      }
    }
    if (changed) {
      console.log('PTZ presets updated from the controller: ' + tokens.join(','));
      this.savePresets();
    }
  }

  // Finds the camera for a Media Profile token. Throws an ONVIF fault if there is none.
  resolveProfile(profileToken: string): { profile: Profile, nodeToken: string, camID: number, cameraAddress: number } {
    const profile = this.profilesArray.find(item => item.attributes.token == profileToken);
    if (!profile) throw noProfile();
    if (!profile.PTZConfiguration) throw noConfig();
    const nodeToken: string = profile.PTZConfiguration.NodeToken;
    const match = /^ptz_node_token_(\d+)$/.exec(nodeToken || '');
    const camID = match ? Number(match[1]) : 0;
    const camera = this.config.Cameras[camID - 1];
    if (!camera) throw noConfig();
    // array starts from Index 0. Default camera address is '1'
    const cameraAddress = Number(camera.PTZCameraAddress) || 1;
    return { profile: profile, nodeToken: nodeToken, camID: camID, cameraAddress: cameraAddress };
  }

  private continuousState(cameraAddress: number): ContinuousState {
    if (!this.continuous[cameraAddress]) {
      this.continuous[cameraAddress] = { pan: 0, tilt: 0, zoom: 0, timer: null };
    }
    return this.continuous[cameraAddress];
  }

  private cancelContinuousTimer(state: ContinuousState) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  // A position move replaces any continuous move
  private resetContinuous(cameraAddress: number) {
    const state = this.continuousState(cameraAddress);
    this.cancelContinuousTimer(state);
    state.pan = 0;
    state.tilt = 0;
    state.zoom = 0;
  }

  // The PTZ Nodes. They are built for each request, because a rposascii controller
  // reports what it can do some time after rpos has started.
  buildNodes(): any[] {
    const driver = this.ptz_driver;
    const caps = driver.rposClient ? driver.rposClient.caps : null;
    const fov = driver.getFov();
    const hasZoom = driver.hasZoom;

    // Normalised ranges. Pan 1.0 is PAN_SCALE_DEG and tilt 1.0 is TILT_SCALE_DEG degrees.
    const range = (degrees: number[] | undefined, scale: number) =>
      degrees ? { Min: clamp(degrees[0] / scale, -1, 1), Max: clamp(degrees[1] / scale, -1, 1) } : { Min: -1.0, Max: 1.0 };
    const xRange = range(caps ? caps.panrange : undefined, PAN_SCALE_DEG);
    const yRange = range(caps ? caps.tiltrange : undefined, TILT_SCALE_DEG);
    const unit = { Min: -1.0, Max: 1.0 };

    let nodesArray = [];

    // PTZ Node is the lowest level in the PTZ system
    for (let i = 1; i <= this.config.Cameras.length; i++) {
      let newNode = {
        attributes : {
          token: `${NODE_TOKEN_PREFIX}${i.toString().padStart(2, '0')}`,
          FixedHomePosition: driver.hasFixedHomePosition,
          GeoMove: false
        },
        Name: `PTZ Node ${i}`,
        SupportedPTZSpaces : {}, // filled in with code below
        MaximumNumberOfPresets : driver.numPresets, // eg 64 for Visca. 255 for Pelco
        HomeSupported : driver.supportsGoToHome,
        AuxiliaryCommands : ['AUX1on','AUX1off','AUX2on','AUX2off',
          'AUX3on','AUX3off','AUX4on','AUX4off',
          'AUX5on','AUX5off','AUX6on','AUX6off',
          'AUX7on','AUX7off','AUX8on','AUX8off']
      }

      if (driver.supportsAbsolutePTZ) {
        newNode.SupportedPTZSpaces['AbsolutePanTiltPositionSpace'] = [{
            URI : SPACE_PAN_TILT_POSITION,
            XRange : xRange,
            YRange : yRange
          }];
        if (hasZoom) {
          newNode.SupportedPTZSpaces['AbsoluteZoomPositionSpace'] = [{
              URI : SPACE_ZOOM_POSITION,
              XRange : unit
            }];
        }
      }
      if (driver.supportsRelativePTZ) {
        const translationSpaces: any[] = [{
            URI : SPACE_PAN_TILT_TRANSLATION,
            XRange : unit,
            YRange : unit
          }];
        // Frigate autotracking needs the field of view space.
        // It moves by a fraction of the picture, so the controller must know the field of view.
        if (fov) {
          translationSpaces.push({
            URI : SPACE_PAN_TILT_TRANSLATION_FOV,
            XRange : unit,
            YRange : unit
          });
        }
        newNode.SupportedPTZSpaces['RelativePanTiltTranslationSpace'] = translationSpaces;
        if (hasZoom) {
          newNode.SupportedPTZSpaces['RelativeZoomTranslationSpace'] = [{
              URI : SPACE_ZOOM_TRANSLATION,
              XRange : unit
            }];
        }
      }
      if (driver.supportsContinuousPTZ) {
        newNode.SupportedPTZSpaces['ContinuousPanTiltVelocitySpace'] = [{
            URI : SPACE_PAN_TILT_VELOCITY,
            XRange : unit,
            YRange : unit
          }];
        if (hasZoom) {
          newNode.SupportedPTZSpaces['ContinuousZoomVelocitySpace'] = [{
              URI : SPACE_ZOOM_VELOCITY,
              XRange : unit
            }];
        }
      }
      if (driver.supportsRelativePTZ || driver.supportsAbsolutePTZ) {
        newNode.SupportedPTZSpaces['PanTiltSpeedSpace'] = [{
            URI : SPACE_PAN_TILT_SPEED,
            XRange : {
              Min : 0,
              Max : 1
            }
          }];
        if (hasZoom) {
          newNode.SupportedPTZSpaces['ZoomSpeedSpace'] = [{
              URI : SPACE_ZOOM_SPEED,
              XRange : {
                Min : 0,
                Max : 1
              }
            }];
        }
      }
      nodesArray.push(newNode);
    }
    return nodesArray;
  }

  private findNode(nodeToken: string): any {
    return this.buildNodes().find(item => item.attributes.token == nodeToken);
  }

  // Speed from an ONVIF Speed element, 0 to 1. undefined if it was not sent.
  private speedFrom(speed: any): { pan?: number, tilt?: number, zoom?: number } {
    const result: { pan?: number, tilt?: number, zoom?: number } = {};
    try {
      if (speed && speed.PanTilt && speed.PanTilt.attributes) {
        const x = num(speed.PanTilt.attributes.x, NaN);
        const y = num(speed.PanTilt.attributes.y, NaN);
        if (isFinite(x)) result.pan = clamp(Math.abs(x), 0, 1);
        if (isFinite(y)) result.tilt = clamp(Math.abs(y), 0, 1);
      }
      if (speed && speed.Zoom && speed.Zoom.attributes) {
        const z = num(speed.Zoom.attributes.x, NaN);
        if (isFinite(z)) result.zoom = clamp(Math.abs(z), 0, 1);
      }
    } catch (err) { }
    return result;
  }

  private statusResponse(info: PTZStatusInfo | null) {
    const now = new Date();
    const utc = now.getUTCFullYear() + '-' + this.leftPad((now.getUTCMonth()+1),2) + '-' + this.leftPad(now.getUTCDate(),2) + 'T'
          + this.leftPad(now.getUTCHours(),2) + ':' + this.leftPad(now.getUTCMinutes(),2) + ':' + this.leftPad(now.getUTCSeconds(),2) + 'Z';

    // The elements are added in the order of the ONVIF schema: Position, MoveStatus, Error, UtcTime
    const status: any = {};
    if (info) {
      if (info.pan !== undefined && info.tilt !== undefined) {
        status.Position = {
          PanTilt: { attributes: { x: info.pan, y: info.tilt, space: SPACE_PAN_TILT_POSITION } }
        };
        if (this.ptz_driver.hasZoom && info.zoom !== undefined) {
          status.Position.Zoom = { attributes: { x: info.zoom, space: SPACE_ZOOM_POSITION } };
        }
      }
      status.MoveStatus = { PanTilt: info.panTilt };
      if (this.ptz_driver.hasZoom) status.MoveStatus.Zoom = info.panTilt;
      if (info.error) status.Error = info.error;
    }
    status.UtcTime = utc;
    return { PTZStatus: status };
  }

  extendService() {
    var port = this.ptz_service.PTZService.PTZ;

    port.GetServiceCapabilities = (args) => {
      var GetServiceCapabilitiesResponse = {
        Capabilities : {
          attributes : {
            EFlip : false,
            Reverse : false,
            GetCompatibleConfigurations : false,
            MoveStatus : this.ptz_driver.supportsMoveStatus(),
            StatusPosition : this.ptz_driver.supportsStatusPosition()
          }
        }
      };
      return GetServiceCapabilitiesResponse;
    };

    port.GetConfigurationOptions = (args) => {
      const config = this.ptzConfigurationsArray.find(item => item.attributes.token == args.ConfigurationToken);
      if (!config) throw noEntity('PTZ configuration');
      const node = this.findNode(config.NodeToken);
      if (!node) throw noEntity('PTZ node');

      let ptzConfigurationOptions = {
        Spaces: node.SupportedPTZSpaces,
        PTZTimeout: {
          Min: 'PT0S',
          Max: 'PT10S'
        },
      };

      var GetConfigurationOptionsResponse = { PTZConfigurationOptions: ptzConfigurationOptions };
      return GetConfigurationOptionsResponse;
    };


    port.GetConfiguration = (args) => {
      const config = this.ptzConfigurationsArray.find(item => item.attributes.token == args.PTZConfigurationToken);
      if (!config) throw noEntity('PTZ configuration');
      var GetConfigurationResponse = { PTZConfiguration: config };
      return GetConfigurationResponse;
    };

    port.GetConfigurations = (args) => {
      var GetConfigurationsResponse = { PTZConfiguration: this.ptzConfigurationsArray };
      return GetConfigurationsResponse;
    };

//    port.GetCompatibleConfigurations = (args) => {
//      var GetCompatibleConfigurationsResponse = { };
//      return GetCompatibleConfigurationsResponse;
//    };

    port.GetNode = (args) => {
      const node = this.findNode(args.NodeToken);
      if (!node) throw noEntity('PTZ node');

      let GetNodeResponse = { PTZNode: node };
      return GetNodeResponse;
    };

    port.GetNodes = (args) => {
      let GetNodesResponse = { PTZNode: this.buildNodes() };
      return GetNodesResponse;
    };

    // Answered by the controller (rposascii v2) or estimated. The reply is sent when it is ready.
    port.GetStatus = (args, done) => {
      this.resolveProfile(args.ProfileToken);
      this.ptz_driver.getStatus().then(
        (info) => done(this.statusResponse(info)),
        (err) => done(this.statusResponse(null)));
    };

    port.SetHomePosition = (args) => {
      const target = this.resolveProfile(args.ProfileToken);
      if (this.callback) this.callback('sethome', { cameraAddress: target.cameraAddress });
      var SetHomePositionResponse = { };
      return SetHomePositionResponse;
    };

    port.GotoHomePosition = (args) => {
      const target = this.resolveProfile(args.ProfileToken);
      this.resetContinuous(target.cameraAddress);
      if (this.callback) this.callback('gotohome', { cameraAddress: target.cameraAddress });
      let GotoHomePositionResponse = {};
      return GotoHomePositionResponse;
    };

    port.ContinuousMove = (args) =>  {
      // Update values or keep last known value
      // ODM sends PanTilt OR Zoom but not both
      // Other VMS systems can send PanTilt AND Zoom together
      const target = this.resolveProfile(args.ProfileToken);
      const state = this.continuousState(target.cameraAddress);

      try {
        state.pan = num(args.Velocity.PanTilt.attributes.x, state.pan);
        state.tilt = num(args.Velocity.PanTilt.attributes.y, state.tilt);
      } catch (err) {}
      try {
        state.zoom = num(args.Velocity.Zoom.attributes.x, state.zoom);
      } catch (err) {}

      // The move ends by itself after the Timeout, if there is one
      this.cancelContinuousTimer(state);
      const timeoutMs = parseDurationMs(args.Timeout);
      if (timeoutMs > 0) {
        state.timer = setTimeout(() => {
          state.timer = null;
          state.pan = 0;
          state.tilt = 0;
          state.zoom = 0;
          if (this.callback) this.callback('stop', { cameraAddress: target.cameraAddress, zoom: 0, stopZoom: true });
        }, timeoutMs);
      }

      if (this.callback) this.callback('ptz', { pan: state.pan, tilt: state.tilt, zoom: state.zoom, cameraAddress: target.cameraAddress });
      var ContinuousMoveResponse = { };
      return ContinuousMoveResponse;
    };

    port.AbsoluteMove = (args) =>  {
      const target = this.resolveProfile(args.ProfileToken);

      let pan: number, tilt: number;
      let zoom = 0;
      try {
        pan = num(args.Position.PanTilt.attributes.x, NaN);
        tilt = num(args.Position.PanTilt.attributes.y, NaN);
      } catch (err) {}
      if (!isFinite(pan) || !isFinite(tilt)) throw invalidArgs('Position.PanTilt is required');
      try { zoom = num(args.Position.Zoom.attributes.x, 0); } catch (err) {}

      const speed = this.speedFrom(args.Speed);
      this.resetContinuous(target.cameraAddress);
      if (this.callback) this.callback('absolute-ptz', {
        pan: pan, tilt: tilt, zoom: zoom,
        panSpeed: speed.pan, tiltSpeed: speed.tilt,
        cameraAddress: target.cameraAddress
      });
      var AbsoluteMoveResponse = { };
      return AbsoluteMoveResponse;
    };

    port.RelativeMove = (args) =>  {
      const target = this.resolveProfile(args.ProfileToken);

      let pan = 0, tilt = 0, zoom = 0;
      let space = 'generic';
      let hasPanTilt = false, hasZoom = false;
      try {
        pan = num(args.Translation.PanTilt.attributes.x, 0);
        tilt = num(args.Translation.PanTilt.attributes.y, 0);
        hasPanTilt = true;
        const spaceUri = args.Translation.PanTilt.attributes.space;
        if (spaceUri !== undefined && spaceUri !== '') {
          // The space must be one the node lists
          const node = this.findNode(target.nodeToken);
          const supported: any[] = (node && node.SupportedPTZSpaces['RelativePanTiltTranslationSpace']) || [];
          if (!supported.some(item => item.URI === spaceUri)) {
            throw onvifFault('ter:InvalidArgVal', 'ter:SpaceNotSupported', 'The translation space is not supported');
          }
          if (spaceUri === SPACE_PAN_TILT_TRANSLATION_FOV) space = 'fov';
        }
      } catch (err) {
        if (err && err.Fault) throw err;
      }
      try {
        zoom = num(args.Translation.Zoom.attributes.x, 0);
        hasZoom = true;
      } catch (err) {}
      if (!hasPanTilt && !hasZoom) throw invalidArgs('Translation is required');

      const speed = this.speedFrom(args.Speed);
      this.resetContinuous(target.cameraAddress);
      if (this.callback) this.callback('relative-ptz', {
        pan: pan, tilt: tilt, zoom: zoom, space: space,
        panSpeed: speed.pan, tiltSpeed: speed.tilt,
        cameraAddress: target.cameraAddress
      });
      var RelativeMoveResponse = { };
      return RelativeMoveResponse;
    };

    port.Stop = (args) =>  {
      // ODM just sends Zoom:true or PanTilt:true
      // Other VMS systems could stop Zoom and PanTilt in one command
      // ONVIF: a flag that is not sent means stop that movement too
      const target = this.resolveProfile(args.ProfileToken);
      const state = this.continuousState(target.cameraAddress);

      const panTiltStop = flag(args.PanTilt, true);
      const zoomStop = flag(args.Zoom, true);
      this.cancelContinuousTimer(state);
      if (panTiltStop) {
        state.pan = 0;
        state.tilt = 0;
      }
      if (zoomStop) {
        state.zoom = 0;
      }
      if (this.callback) {
        if (panTiltStop) {
          // stops position moves as well as velocity moves
          this.callback('stop', { zoom: state.zoom, stopZoom: zoomStop, cameraAddress: target.cameraAddress });
        } else {
          this.callback('ptz', { pan: state.pan, tilt: state.tilt, zoom: state.zoom, cameraAddress: target.cameraAddress });
        }
      }
      var StopResponse = { };
      return StopResponse;
    };


    //var SendAuxiliaryCommand = {
    //  ProfileToken : { xs:string},
    //  AuxiliaryData : { xs:string}
    //};
    port.SendAuxiliaryCommand = (args) => {
      const target = this.resolveProfile(args.ProfileToken);

      if (this.callback) this.callback('aux', { name: args.AuxiliaryData, cameraAddress: target.cameraAddress });
      var SendAuxiliaryCommandResponse = {
        AuxiliaryResponse : true // no idea what the value should be
      };
      return SendAuxiliaryCommandResponse;
    };

    port.GetPresets = (args) => {

      // Take the Media Profile Token (passed in) and get the PTZ Node and then return the relevent list of presets for that Node
      const ptz_node_token = this.resolveProfile(args.ProfileToken).nodeToken; // eg ptz_node_token_01

      var GetPresetsResponse = { Preset: [] };

      for (let i = 0 ; i < this.presetArray.length; i++) {
        if (this.presetArray[i].ptzNodeToken === ptz_node_token
        && this.presetArray[i].used == true) {
          var p = {
            attributes: {
              token: this.presetArray[i].presetToken
            },
            Name: this.presetArray[i].presetName
          };
          GetPresetsResponse.Preset.push(p);
        }
      }
      return GetPresetsResponse;
    };


    port.GotoPreset = (args) => {
      const arg_presetToken = args.PresetToken;

      const target = this.resolveProfile(args.ProfileToken);
      const ptzNodeToken = target.nodeToken;
      const cameraPTZAddress = target.cameraAddress;

      // Args has a PresetToken and a ProfileToken
      let GotoPresetResponse = { };

      for (let i = 0 ; i < this.presetArray.length; i++) {
        if (ptzNodeToken === this.presetArray[i].ptzNodeToken
        && arg_presetToken === this.presetArray[i].presetToken
        && this.presetArray[i].used == true) {
          this.resetContinuous(cameraPTZAddress);
          if (this.callback) this.callback('gotopreset', { name: this.presetArray[i].presetName,
            value: this.presetArray[i].presetToken, cameraAddress: cameraPTZAddress
          });
          break;
        }
      }
      return GotoPresetResponse;
    };

    port.RemovePreset = (args) => {
      // find the preset in the array of presets and set "used" to false
      const target = this.resolveProfile(args.ProfileToken);
      const ptzNodeToken = target.nodeToken;
      const cameraAddress = target.cameraAddress;

      let RemovePresetResponse = { };

      let matching_presetToken = args.PresetToken;

      for (let i = 0 ; i < this.presetArray.length; i++) {
        if (ptzNodeToken === this.presetArray[i].ptzNodeToken
        && matching_presetToken === this.presetArray[i].presetToken
        && this.presetArray[i].fixed == false) {
          // update the array, then schedule a save to disk
          this.presetArray[i].used = false; // set used to false
          this.presetArray[i].presetName = ""; // clear the name
          if (this.callback) this.callback('clearpreset', { name: this.presetArray[i].presetName,
            value: this.presetArray[i].presetToken, cameraAddress: cameraAddress
          });
          this.savePresets();
          break;
        }
      }

      return RemovePresetResponse;
    };

    port.SetPreset = (args) => {
      // Find the first preset slot that is unused
      const target = this.resolveProfile(args.ProfileToken);
      const ptzNodeToken = target.nodeToken;
      const cameraAddress = target.cameraAddress;


      let SetPresetResponse;

      let presetName = args.PresetName;   // used when creating a preset
      let presetToken = args.PresetToken; // used when updating an existing preset
                                          // Note ODM's Create Preset supplies a Preset Token, but we ignore it

      let existingPreset = null;
      if ('PresetToken' in args && args.PresetToken.length > 0) {
        // check for existing preset
        existingPreset = this.presetArray.find(item => item.ptzNodeToken == ptzNodeToken && item.presetToken == args.PresetToken);
      }


      // If the ONVIF command contains no Preset Token, this is a NEW Preset and we return the new Preset Token in our reply.
      // If the ONVIF command contains a Preset Token, and that Preset Token already existins in our array of Presets, then this is an UPDATE. We may have to UPDATE the Name too.
      // If the ONVIF command contains an Unknown Preset Token (like ODM does) we treat this as a NEW Preset and ignore the unknown Preset Token. We return the actual new Preset Token in the reply.

      // CHECK FOR UPDATE
      if (existingPreset != null && existingPreset != undefined) {
        // Optional update of the name. A slot that was not in use becomes a used preset.
        let changed = false;
        if ('PresetName' in args && existingPreset.presetName != args.PresetName) {
          existingPreset.presetName = args.PresetName;
          changed = true;
        }
        if (!existingPreset.used) {
          existingPreset.used = true;
          changed = true;
        }
        if (changed) this.savePresets();
        // Send to the physical camera device
        if (this.callback) this.callback('setpreset', { name: existingPreset.presetName,
          value: presetToken, cameraAddress: cameraAddress
          });

        SetPresetResponse = { PresetToken : presetToken};

        return SetPresetResponse;
      } else {
        // New Preset
        // Find the first unused token and use it. The controller may hold fewer presets than we have slots for.
        let new_presetToken = '';
        for (let i = 0; i < this.presetArray.length; i++) {
          if (ptzNodeToken === this.presetArray[i].ptzNodeToken
          && this.presetArray[i].used == false
          && Number(this.presetArray[i].presetToken) <= this.ptz_driver.numPresets) {
            this.presetArray[i].presetName = presetName;
            this.presetArray[i].used = true;
            new_presetToken = this.presetArray[i].presetToken;
            if (this.callback) this.callback('setpreset', { name: presetName,
              value: new_presetToken, cameraAddress: cameraAddress
            });
            break;
          }
        }
        if (new_presetToken === '') throw onvifFault('ter:InvalidArgVal', 'ter:TooManyPresets', 'No free preset slot');

        this.savePresets();

        SetPresetResponse = { PresetToken : new_presetToken};
        return SetPresetResponse;
      }
    };
  }
}
export = PTZService;
