///<reference path="../rpos.d.ts"/>

// Builds an object that a node-soap handler can throw to send an ONVIF fault.
// Example: throw onvifFault('ter:InvalidArgVal', 'ter:NoProfile', 'Profile not found');
export function onvifFault(subcode: string, subsubcode: string, reason: string): any {
  const sub: any = { Value: subcode };
  if (subsubcode) sub.Subcode = { Value: subsubcode };
  return {
    Fault: {
      attributes: {
        'xmlns:ter': 'http://www.onvif.org/ver10/error',
      },
      Code: {
        Value: 'soap:Sender',
        Subcode: sub,
      },
      Reason: {
        Text: {
          attributes: {
            'xml:lang': 'en',
          },
          $value: reason,
        }
      }
    }
  };
}

export const noProfile = () => onvifFault('ter:InvalidArgVal', 'ter:NoProfile', 'The requested profile token does not exist');
export const noConfig = () => onvifFault('ter:InvalidArgVal', 'ter:NoConfig', 'The profile has no PTZ configuration');
export const noEntity = (what: string) => onvifFault('ter:InvalidArgVal', 'ter:NoEntity', 'The requested ' + what + ' does not exist');
export const invalidArgs = (reason: string) => onvifFault('ter:InvalidArgVal', 'ter:InvalidArgs', reason);
