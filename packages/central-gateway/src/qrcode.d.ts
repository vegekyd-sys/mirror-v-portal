declare module 'qrcode' {
  interface QRCodeOptions {
    width?: number;
    margin?: number;
    color?: {
      dark?: string;
      light?: string;
    };
    errorCorrectionLevel?: 'low' | 'medium' | 'quartile' | 'high';
  }
  export function toDataURL(text: string, options?: QRCodeOptions): Promise<string>;
  export function toBuffer(text: string, options?: QRCodeOptions): Promise<Buffer>;
  export function toString(text: string, options?: QRCodeOptions): Promise<string>;
}
