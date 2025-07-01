/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import {Blob} from '@google/genai';

function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function createBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    // convert float32 -1 to 1 to int16 -32768 to 32767
    int16[i] = Math.max(-32768, Math.min(32767, data[i] * 32768));
  }

  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000', // Assuming 16kHz, adjust if Lyria's internal sample rate for PCM is different
  };
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  // Ensure data length is even for Int16Array conversion
  const byteLength = data.length % 2 === 0 ? data.length : data.length -1;
  const bufferLength = byteLength / 2 / numChannels;

  if (bufferLength === 0) {
      console.warn("Received empty or malformed audio data for decoding.");
      // Return an empty buffer or handle error as appropriate
      return ctx.createBuffer(numChannels > 0 ? numChannels : 1, 1, sampleRate); 
  }
  
  const buffer = ctx.createBuffer(
    numChannels,
    bufferLength, 
    sampleRate,
  );

  // Use data.buffer and specify byteOffset and byteLength for Int16Array
  const dataInt16 = new Int16Array(data.buffer, data.byteOffset, byteLength / 2);
  const l = dataInt16.length;
  const dataFloat32 = new Float32Array(l);
  for (let i = 0; i < l; i++) {
    dataFloat32[i] = dataInt16[i] / 32768.0;
  }

  // Extract interleaved channels
  if (numChannels === 1) { // Correctly handle mono audio
    buffer.copyToChannel(dataFloat32, 0);
  } else if (numChannels > 1) { // Handle stereo or multi-channel
    for (let i = 0; i < numChannels; i++) {
      const channelData = new Float32Array(bufferLength);
      for (let j = 0; j < bufferLength; j++) {
        channelData[j] = dataFloat32[j * numChannels + i];
      }
      buffer.copyToChannel(channelData, i);
    }
  } else {
      console.warn(`Invalid number of channels: ${numChannels}. Cannot process audio data.`);
      // Potentially return an empty or silent buffer
      return ctx.createBuffer(1, 1, sampleRate); // Fallback to silent mono buffer
  }

  return buffer;
}

export {createBlob, decode, decodeAudioData, encode};
