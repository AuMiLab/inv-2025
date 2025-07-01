/**
 * @fileoverview Control real time music with text prompts
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {css, CSSResultGroup, html, LitElement, svg} from 'lit';
import {customElement, property, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {styleMap} from 'lit/directives/style-map.js';

import {
  GoogleGenAI,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai';
import {decode, decodeAudioData} from './utils';

// Use process.env.API_KEY as per guidelines
const ai = new GoogleGenAI({
  apiKey: process.env.API_KEY,
  apiVersion: 'v1alpha', // Keep v1alpha as Lyria features might depend on it
});
let model = 'lyria-realtime-exp';

interface Prompt {
  readonly promptId: string;
  readonly color: string;
  text: string;
  weight: number;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

/** Throttles a callback to be called at most once per `freq` milliseconds. */
function throttle(func: (...args: unknown[]) => void, delay: number) {
  let lastCall = 0;
  return (...args: unknown[]) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delay) {
      func(...args);
      lastCall = now;
    }
  };
}

const PROMPT_TEXT_PRESETS = [
  'Bossa Nova',
  'Minimal Techno',
  'Drum and Bass',
  'Post Punk',
  'Shoegaze',
  'Funk',
  'Chiptune',
  'Lush Strings',
  'Sparkling Arpeggios',
  'Staccato Rhythms',
  'Punchy Kick',
  'Dubstep',
  'K Pop',
  'Neo Soul',
  'Trip Hop',
  'Thrash',
];

const COLORS = [
  '#9900ff',
  '#5200ff',
  '#ff25f6',
  '#2af6de',
  '#ffdd28',
  '#3dffab',
  '#d8ff3e',
  '#d9b2ff',
];

function getUnusedRandomColor(usedColors: string[]): string {
  const availableColors = COLORS.filter((c) => !usedColors.includes(c));
  if (availableColors.length === 0) {
    // If no available colors, pick a random one from the original list.
    return COLORS[Math.floor(Math.random() * COLORS.length)];
  }
  return availableColors[Math.floor(Math.random() * availableColors.length)];
}

// WeightSlider component
// -----------------------------------------------------------------------------
/** A slider for adjusting and visualizing prompt weight. */
@customElement('weight-slider')
class WeightSlider extends LitElement {
  static override styles = css`
    :host {
      cursor: ns-resize;
      position: relative;
      height: 100%;
      display: flex;
      justify-content: center;
      flex-direction: column;
      align-items: center;
      padding: 5px;
    }
    .scroll-container {
      width: 100%;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    .value-display {
      font-size: 1.3vmin;
      color: #ccc;
      margin: 0.5vmin 0;
      user-select: none;
      text-align: center;
    }
    .slider-container {
      position: relative;
      width: 10px;
      height: 100%;
      background-color: #0009;
      border-radius: 4px;
    }
    #thumb {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      border-radius: 4px;
      box-shadow: 0 0 3px rgba(0, 0, 0, 0.7);
    }
  `;

  @property({type: Number}) value = 0; // Range 0-2
  @property({type: String}) color = '#000';

  @query('.scroll-container') private scrollContainer!: HTMLDivElement;

  private dragStartPos = 0;
  private dragStartValue = 0;
  private containerBounds: DOMRect | null = null;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    this.containerBounds = this.scrollContainer.getBoundingClientRect();
    this.dragStartPos = e.clientY;
    this.dragStartValue = this.value;
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('touchmove', this.handleTouchMove, {
      passive: false,
    });
    window.addEventListener('pointerup', this.handlePointerUp, {once: true});
    this.updateValueFromPosition(e.clientY);
  }

  private handlePointerMove(e: PointerEvent) {
    this.updateValueFromPosition(e.clientY);
  }

  private handleTouchMove(e: TouchEvent) {
    e.preventDefault();
    this.updateValueFromPosition(e.touches[0].clientY);
  }

  private handlePointerUp(e: PointerEvent) {
    window.removeEventListener('pointermove', this.handlePointerMove);
    document.body.classList.remove('dragging');
    this.containerBounds = null;
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY;
    this.value = this.value + delta * -0.005;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchInputEvent();
  }

  private updateValueFromPosition(clientY: number) {
    if (!this.containerBounds) return;

    const trackHeight = this.containerBounds.height;
    // Calculate position relative to the top of the track
    const relativeY = clientY - this.containerBounds.top;
    // Invert and normalize (0 at bottom, 1 at top)
    const normalizedValue =
      1 - Math.max(0, Math.min(trackHeight, relativeY)) / trackHeight;
    // Scale to 0-2 range
    this.value = normalizedValue * 2;

    this.dispatchInputEvent();
  }

  private dispatchInputEvent() {
    this.dispatchEvent(new CustomEvent<number>('input', {detail: this.value}));
  }

  override render() {
    const thumbHeightPercent = (this.value / 2) * 100;
    const thumbStyle = styleMap({
      height: `${thumbHeightPercent}%`,
      backgroundColor: this.color,
      // Hide thumb if value is 0 or very close to prevent visual glitch
      display: this.value > 0.01 ? 'block' : 'none',
    });
    const displayValue = this.value.toFixed(2);

    return html`
      <div
        class="scroll-container"
        @pointerdown=${this.handlePointerDown}
        @wheel=${this.handleWheel}>
        <div class="slider-container">
          <div id="thumb" style=${thumbStyle}></div>
        </div>
        <div class="value-display">${displayValue}</div>
      </div>
    `;
  }
}

// Base class for icon buttons.
class IconButton extends LitElement {
  static override styles = css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    :host(:hover) svg {
      transform: scale(1.2);
    }
    svg {
      width: 100%;
      height: 100%;
      transition: transform 0.5s cubic-bezier(0.25, 1.56, 0.32, 0.99);
    }
    .hitbox {
      pointer-events: all;
      position: absolute;
      width: 65%;
      aspect-ratio: 1;
      top: 9%;
      border-radius: 50%;
      cursor: pointer;
    }
  ` as CSSResultGroup;

  // Method to be implemented by subclasses to provide the specific icon SVG
  protected renderIcon() {
    return svg``; // Default empty icon
  }

  private renderSVG() {
    return html` <svg
      width="140"
      height="140"
      viewBox="0 -10 140 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg">
      <rect
        x="22"
        y="6"
        width="96"
        height="96"
        rx="48"
        fill="black"
        fill-opacity="0.05" />
      <rect
        x="23.5"
        y="7.5"
        width="93"
        height="93"
        rx="46.5"
        stroke="black"
        stroke-opacity="0.3"
        stroke-width="3" />
      <g filter="url(#filter0_ddi_1048_7373)">
        <rect
          x="25"
          y="9"
          width="90"
          height="90"
          rx="45"
          fill="white"
          fill-opacity="0.05"
          shape-rendering="crispEdges" />
      </g>
      ${this.renderIcon()}
      <defs>
        <filter
          id="filter0_ddi_1048_7373"
          x="0"
          y="0"
          width="140"
          height="140"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="4" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow_1048_7373" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="16" />
          <feGaussianBlur stdDeviation="12.5" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="effect1_dropShadow_1048_7373"
            result="effect2_dropShadow_1048_7373" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect2_dropShadow_1048_7373"
            result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="3" />
          <feGaussianBlur stdDeviation="1.5" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.05 0" />
          <feBlend
            mode="normal"
            in2="shape"
            result="effect3_innerShadow_1048_7373" />
        </filter>
      </defs>
    </svg>`;
  }

  override render() {
    return html`${this.renderSVG()}<div class="hitbox"></div>`;
  }
}

// PlayPauseButton
// -----------------------------------------------------------------------------

/** A button for toggling play/pause. */
@customElement('play-pause-button')
export class PlayPauseButton extends IconButton {
  @property({type: String}) playbackState: PlaybackState = 'stopped';

  static override styles = [
    IconButton.styles,
    css`
      .loader {
        stroke: #ffffff;
        stroke-width: 3;
        stroke-linecap: round;
        animation: spin linear 1s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(359deg);
        }
      }
    `,
  ];

  private renderPause() {
    return svg`<path
      d="M75.0037 69V39H83.7537V69H75.0037ZM56.2537 69V39H65.0037V69H56.2537Z"
      fill="#FEFEFE"
    />`;
  }

  private renderPlay() {
    return svg`<path d="M60 71.5V36.5L87.5 54L60 71.5Z" fill="#FEFEFE" />`;
  }

  private renderLoading() {
    return svg`<path shape-rendering="crispEdges" class="loader" d="M70,74.2L70,74.2c-10.7,0-19.5-8.7-19.5-19.5l0,0c0-10.7,8.7-19.5,19.5-19.5
            l0,0c10.7,0,19.5,8.7,19.5,19.5l0,0"/>`;
  }

  override renderIcon() {
    if (this.playbackState === 'playing') {
      return this.renderPause();
    } else if (this.playbackState === 'loading') {
      return this.renderLoading();
    } else {
      return this.renderPlay();
    }
  }
}

@customElement('reset-button')
export class ResetButton extends IconButton {
  private renderResetIcon() {
    return svg`<path fill="#fefefe" d="M71,77.1c-2.9,0-5.7-0.6-8.3-1.7s-4.8-2.6-6.7-4.5c-1.9-1.9-3.4-4.1-4.5-6.7c-1.1-2.6-1.7-5.3-1.7-8.3h4.7
      c0,4.6,1.6,8.5,4.8,11.7s7.1,4.8,11.7,4.8c4.6,0,8.5-1.6,11.7-4.8c3.2-3.2,4.8-7.1,4.8-11.7s-1.6-8.5-4.8-11.7
      c-3.2-3.2-7.1-4.8-11.7-4.8h-0.4l3.7,3.7L71,46.4L61.5,37l9.4-9.4l3.3,3.4l-3.7,3.7H71c2.9,0,5.7,0.6,8.3,1.7
      c2.6,1.1,4.8,2.6,6.7,4.5c1.9,1.9,3.4,4.1,4.5,6.7c1.1,2.6,1.7,5.3,1.7,8.3c0,2.9-0.6,5.7-1.7,8.3c-1.1,2.6-2.6,4.8-4.5,6.7
      s-4.1,3.4-6.7,4.5C76.7,76.5,73.9,77.1,71,77.1z"/>`;
  }

  override renderIcon() {
    return this.renderResetIcon();
  }
}

// AddPromptButton component
// -----------------------------------------------------------------------------
/** A button for adding a new prompt. */
@customElement('add-prompt-button')
export class AddPromptButton extends IconButton {
  private renderAddIcon() {
    return svg`<path d="M67 40 H73 V52 H85 V58 H73 V70 H67 V58 H55 V52 H67 Z" fill="#FEFEFE" />`;
  }

  override renderIcon() {
    return this.renderAddIcon();
  }
}

// RecordButton component
// -----------------------------------------------------------------------------
/** A button for toggling audio recording. */
@customElement('record-button')
export class RecordButton extends IconButton {
  @property({type: Boolean}) recording = false;

  static override styles = [
    IconButton.styles,
    css`
      .record-icon-active {
        animation: pulse 1.5s infinite ease-in-out;
      }
      @keyframes pulse {
        0% { opacity: 1; }
        50% { opacity: 0.6; }
        100% { opacity: 1; }
      }
    `,
  ];

  private renderRecordIcon() {
    // Red circle for "start recording"
    return svg`<circle cx="70" cy="54" r="14" fill="#FF4136"/>`;
  }

  private renderStopIcon() {
    // White square for "stop recording"
    return svg`<rect class="record-icon-active" x="58" y="42" width="24" height="24" rx="2" fill="#FEFEFE"/>`;
  }

  override renderIcon() {
    if (this.recording) {
      return this.renderStopIcon();
    } else {
      return this.renderRecordIcon();
    }
  }
}


// Toast Message component
// -----------------------------------------------------------------------------

@customElement('toast-message')
class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      line-height: 1.6;
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #000;
      color: white;
      padding: 15px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      min-width: 200px;
      max-width: 80vw;
      transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1);
      z-index: 11;
    }
    button {
      border-radius: 100px;
      aspect-ratio: 1;
      border: none;
      color: #000;
      cursor: pointer;
    }
    .toast:not(.showing) {
      transition-duration: 1s;
      transform: translate(-50%, -200%);
    }
  `;

  @property({type: String}) message = '';
  @property({type: Boolean}) showing = false;

  override render() {
    return html`<div class=${classMap({showing: this.showing, toast: true})}>
      <div class="message">${this.message}</div>
      <button @click=${this.hide}>✕</button>
    </div>`;
  }

  show(message: string) {
    this.showing = true;
    this.message = message;
  }

  hide() {
    this.showing = false;
  }
}

/** A single prompt input */
@customElement('prompt-controller')
class PromptController extends LitElement {
  static override styles = css`
    .prompt {
      position: relative;
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      box-sizing: border-box;
      overflow: hidden;
      background-color: #2a2a2a;
      border-radius: 5px;
    }
    .remove-button {
      position: absolute;
      top: 1.2vmin;
      left: 1.2vmin;
      background: #666;
      color: #fff;
      border: none;
      border-radius: 50%;
      width: 2.8vmin;
      height: 2.8vmin;
      font-size: 1.8vmin;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 2.8vmin;
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.2s;
      z-index: 10;
    }
    .remove-button:hover {
      opacity: 1;
    }
    weight-slider {
      /* Calculate height: 100% of parent minus controls height and margin */
      max-height: calc(100% - 9vmin);
      flex: 1;
      min-height: 10vmin;
      width: 100%;
      box-sizing: border-box;
      overflow: hidden;
      margin: 2vmin 0 1vmin;
    }
    .controls {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      align-items: center;
      gap: 0.2vmin;
      width: 100%;
      height: 8vmin;
      padding: 0 0.5vmin;
      box-sizing: border-box;
      margin-bottom: 1vmin;
    }
    #text {
      font-family: 'Google Sans', sans-serif;
      font-size: 1.8vmin;
      width: 100%;
      flex-grow: 1;
      max-height: 100%;
      padding: 0.4vmin;
      box-sizing: border-box;
      text-align: center;
      word-wrap: break-word;
      overflow-y: auto;
      border: none;
      outline: none;
      -webkit-font-smoothing: antialiased;
      color: #fff;
      scrollbar-width: thin;
      scrollbar-color: #666 #1a1a1a;
    }
    #text::-webkit-scrollbar {
      width: 6px;
    }
    #text::-webkit-scrollbar-track {
      background: #0009;
      border-radius: 3px;
    }
    #text::-webkit-scrollbar-thumb {
      background-color: #666;
      border-radius: 3px;
    }
    :host([filtered='true']) #text {
      background: #da2000;
    }
  `;

  @property({type: String, reflect: true}) promptId = '';
  @property({type: String}) text = '';
  @property({type: Number}) weight = 0;
  @property({type: String}) color = '';

  @query('weight-slider') private weightInput!: WeightSlider;
  @query('#text') private textInput!: HTMLSpanElement;

  private handleTextKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.updateText();
      (e.target as HTMLElement).blur();
    }
  }

  private dispatchPromptChange() {
    this.dispatchEvent(
      new CustomEvent<Prompt>('prompt-changed', {
        detail: {
          promptId: this.promptId,
          text: this.text,
          weight: this.weight,
          color: this.color,
        },
      }),
    );
  }

  private updateText() {
    console.log('updateText');
    const newText = this.textInput.textContent?.trim();
    if (newText === '') {
      this.textInput.textContent = this.text;
      return;
    }
    if (newText) {
        this.text = newText;
    }
    this.dispatchPromptChange();
  }

  private updateWeight() {
    this.weight = this.weightInput.value;
    this.dispatchPromptChange();
  }

  private dispatchPromptRemoved() {
    this.dispatchEvent(
      new CustomEvent<string>('prompt-removed', {
        detail: this.promptId,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const classes = classMap({
      'prompt': true,
    });
    return html`<div class=${classes}>
      <button class="remove-button" @click=${this.dispatchPromptRemoved}
        >×</button
      >
      <weight-slider
        id="weight"
        value=${this.weight}
        color=${this.color}
        @input=${this.updateWeight}></weight-slider>
      <div class="controls">
        <span
          id="text"
          spellcheck="false"
          contenteditable="plaintext-only"
          @keydown=${this.handleTextKeyDown}
          @blur=${this.updateText}
          >${this.text}</span
        >
      </div>
    </div>`;
  }
}

interface SettingsControllerState {
  musicGenerationConfig: LiveMusicGenerationConfig;
  showSpectrogram: boolean;
}


/** A panel for managing real-time music generation settings. */
@customElement('settings-controller')
class SettingsController extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 2vmin;
      background-color: #2a2a2a;
      color: #eee;
      box-sizing: border-box;
      border-radius: 5px;
      font-family: 'Google Sans', sans-serif;
      font-size: 1.5vmin;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #666 #1a1a1a;
      transition: width 0.3s ease-out max-height 0.3s ease-out;
    }
    :host([showadvanced]) {
      max-height: 40vmin;
    }
    :host::-webkit-scrollbar {
      width: 6px;
    }
    :host::-webkit-scrollbar-track {
      background: #1a1a1a;
      border-radius: 3px;
    }
    :host::-webkit-scrollbar-thumb {
      background-color: #666;
      border-radius: 3px;
    }
    .setting {
      margin-bottom: 0.5vmin;
      display: flex;
      flex-direction: column;
      gap: 0.5vmin;
    }
    label {
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
      white-space: nowrap;
      user-select: none;
    }
    label span:last-child {
      font-weight: normal;
      color: #ccc;
      min-width: 3em;
      text-align: right;
    }
    input[type='range'] {
      --track-height: 8px;
      --track-bg: #0009;
      --track-border-radius: 4px;
      --thumb-size: 16px;
      --thumb-bg: #5200ff;
      --thumb-border-radius: 50%;
      --thumb-box-shadow: 0 0 3px rgba(0, 0, 0, 0.7);
      --value-percent: 0%;
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: var(--track-height);
      background: transparent;
      cursor: pointer;
      margin: 0.5vmin 0;
      border: none;
      padding: 0;
      vertical-align: middle;
    }
    input[type='range']::-webkit-slider-runnable-track {
      width: 100%;
      height: var(--track-height);
      cursor: pointer;
      border: none;
      background: linear-gradient(
        to right,
        var(--thumb-bg) var(--value-percent),
        var(--track-bg) var(--value-percent)
      );
      border-radius: var(--track-border-radius);
    }
    input[type='range']::-moz-range-track {
      width: 100%;
      height: var(--track-height);
      cursor: pointer;
      background: var(--track-bg);
      border-radius: var(--track-border-radius);
      border: none;
    }
    input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      height: var(--thumb-size);
      width: var(--thumb-size);
      background: var(--thumb-bg);
      border-radius: var(--thumb-border-radius);
      box-shadow: var(--thumb-box-shadow);
      cursor: pointer;
      margin-top: calc((var(--thumb-size) - var(--track-height)) / -2);
    }
    input[type='range']::-moz-range-thumb {
      height: var(--thumb-size);
      width: var(--thumb-size);
      background: var(--thumb-bg);
      border-radius: var(--thumb-border-radius);
      box-shadow: var(--thumb-box-shadow);
      cursor: pointer;
      border: none;
    }
    input[type='number'],
    input[type='text'],
    select {
      background-color: #2a2a2a;
      color: #eee;
      border: 1px solid #666;
      border-radius: 3px;
      padding: 0.4vmin;
      font-size: 1.5vmin;
      font-family: inherit;
      box-sizing: border-box;
    }
    input[type='number'] {
      width: 6em;
    }
    input[type='text'] {
      width: 100%;
    }
    input[type='text']::placeholder {
      color: #888;
    }
    input[type='number']:focus,
    input[type='text']:focus {
      outline: none;
      border-color: #5200ff;
      box-shadow: 0 0 0 2px rgba(82, 0, 255, 0.3);
    }
    select {
      width: 100%;
    }
    select:focus {
      outline: none;
      border-color: #5200ff;
    }
    select option {
      background-color: #2a2a2a;
      color: #eee;
    }
    .checkbox-setting {
      flex-direction: row;
      align-items: center;
      gap: 1vmin;
    }
    input[type='checkbox'] {
      cursor: pointer;
      accent-color: #5200ff;
    }
    .core-settings-row {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 4vmin;
      margin-bottom: 1vmin;
      justify-content: space-evenly;
    }
    .core-settings-row .setting {
      min-width: 16vmin;
    }
    .core-settings-row label span:last-child {
      min-width: 2.5em;
    }
    .advanced-toggle {
      cursor: pointer;
      margin: 2vmin 0 1vmin 0;
      color: #aaa;
      text-decoration: underline;
      user-select: none;
      font-size: 1.4vmin;
      width: fit-content;
    }
    .advanced-toggle:hover {
      color: #eee;
    }
    .advanced-settings {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10vmin, 1fr));
      gap: 3vmin;
      overflow: hidden;
      max-height: 0;
      opacity: 0;
      transition:
        max-height 0.3s ease-out,
        opacity 0.3s ease-out;
    }
    .advanced-settings.visible {
      max-width: 120vmin;
      max-height: 40vmin;
      opacity: 1;
    }
    hr.divider {
      display: none;
      border: none;
      border-top: 1px solid #666;
      margin: 2vmin 0;
      width: 100%;
    }
    :host([showadvanced]) hr.divider {
      display: block;
    }
    .auto-row {
      display: flex;
      align-items: center;
      gap: 0.5vmin;
    }
    .setting[auto='true'] input[type='range'] {
      pointer-events: none;
      filter: grayscale(100%);
    }
    .auto-row span {
      margin-left: auto;
    }
    .auto-row label {
      cursor: pointer;
    }
    .auto-row input[type='checkbox'] {
      cursor: pointer;
      margin: 0;
    }
  `;

  private readonly defaultConfig: LiveMusicGenerationConfig = {
    temperature: 1.1,
    topK: 40,
    guidance: 4.0,
  };

  @state() private config: LiveMusicGenerationConfig = this.defaultConfig;
  @state() showAdvanced = false;
  @state() autoDensity = true;
  @state() lastDefinedDensity: number | undefined;
  @state() autoBrightness = true;
  @state() lastDefinedBrightness: number | undefined;
  @state() private showSpectrogram = true;


  public resetToDefaults() {
    this.config = this.defaultConfig;
    this.autoDensity = true;
    this.lastDefinedDensity = undefined;
    this.autoBrightness = true;
    this.lastDefinedBrightness = undefined;
    this.showSpectrogram = true;
    this.dispatchSettingsChange();
  }

  private updateSliderBackground(inputEl: HTMLInputElement) {
    if (inputEl.type !== 'range') {
      return;
    }
    const min = Number(inputEl.min) || 0;
    const max = Number(inputEl.max) || 100;
    const value = Number(inputEl.value);
    const percentage = ((value - min) / (max - min)) * 100;
    inputEl.style.setProperty('--value-percent', `${percentage}%`);
  }

  private handleInputChange(e: Event) {
    const target = e.target as (HTMLInputElement | HTMLSelectElement);
    const key = target.id;
    let value: string | number | boolean | undefined = target.value;

    if (target.type === 'number' || target.type === 'range') {
      value = target.value === '' ? undefined : Number(target.value);
      if (target.type === 'range') {
        this.updateSliderBackground(target as HTMLInputElement);
      }
    } else if (target.type === 'checkbox') {
      value = (target as HTMLInputElement).checked;
    } else if (target.type === 'select-one') {
      const selectElement = target as HTMLSelectElement;
      if (selectElement.options[selectElement.selectedIndex]?.disabled) {
        value = undefined;
      } else {
        value = target.value;
      }
    }

    let newConfig = { ...this.config };

    if (key === 'showSpectrogram') {
      this.showSpectrogram = Boolean(value);
    } else if (key === 'auto-density') {
      this.autoDensity = Boolean(value);
      newConfig.density = this.autoDensity
        ? undefined
        : this.lastDefinedDensity ?? 0.5;
    } else if (key === 'auto-brightness') {
      this.autoBrightness = Boolean(value);
      newConfig.brightness = this.autoBrightness
        ? undefined
        : this.lastDefinedBrightness ?? 0.5;
    } else if (key in newConfig) { // Check if key is a valid LiveMusicGenerationConfig key
        (newConfig as any)[key] = value as any; // Cast value to any to satisfy TS
        if (newConfig.density !== undefined && key === 'density') {
            this.lastDefinedDensity = newConfig.density;
        }
        if (newConfig.brightness !== undefined && key === 'brightness') {
            this.lastDefinedBrightness = newConfig.brightness;
        }
    }
    
    this.config = newConfig;
    this.dispatchSettingsChange();
  }

  override updated(changedProperties: Map<string | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has('config') || changedProperties.has('lastDefinedDensity') || changedProperties.has('lastDefinedBrightness') ) {
      this.shadowRoot
        ?.querySelectorAll<HTMLInputElement>('input[type="range"]')
        .forEach((slider: HTMLInputElement) => {
          const configKey = slider.id as keyof LiveMusicGenerationConfig;
          let valueFromConfig: unknown; // Use unknown to force type checking

          if (configKey === 'density') {
            valueFromConfig = this.autoDensity ? (this.lastDefinedDensity ?? 0.5) : this.config.density;
          } else if (configKey === 'brightness') {
            valueFromConfig = this.autoBrightness ? (this.lastDefinedBrightness ?? 0.5) : this.config.brightness;
          } else if (configKey === 'temperature' || configKey === 'guidance' || configKey === 'topK') {
            valueFromConfig = this.config[configKey];
          } else {
            // This case should ideally not be reached if slider IDs are correctly mapped to config keys
            console.error(`SettingsController: Unhandled range slider key '${String(configKey)}' in updated() method.`);
            return; // Skip this slider
          }

          let numericValueToSet: number;

          if (typeof valueFromConfig === 'number' && isFinite(valueFromConfig)) {
            numericValueToSet = valueFromConfig;
          } else {
            // Fallback logic if valueFromConfig is not a valid finite number
            console.warn(`SettingsController: Configuration for slider '${String(configKey)}' is not a valid finite number (value: ${valueFromConfig}, type: ${typeof valueFromConfig}). Using fallback.`);
            if ((configKey === 'density' || configKey === 'brightness') && valueFromConfig === undefined) {
                // Specific default for auto density/brightness when explicitly undefined (first load or reset)
                numericValueToSet = 0.5;
            } else {
                 // General fallback for other unexpected types, NaN, Infinity, or undefined for non-auto properties
                const sliderMin = parseFloat(slider.min);
                const sliderDefault = parseFloat(slider.defaultValue);

                if (isFinite(sliderDefault)) {
                    numericValueToSet = sliderDefault;
                } else if (isFinite(sliderMin)) {
                    numericValueToSet = sliderMin;
                } else {
                    numericValueToSet = 0; // Absolute fallback
                }
            }
          }
          
          slider.value = String(numericValueToSet);
          this.updateSliderBackground(slider);
        });
    }
  }

  private dispatchSettingsChange() {
    this.dispatchEvent(
      new CustomEvent<SettingsControllerState>('settings-changed', {
        detail: {
          musicGenerationConfig: this.config,
          showSpectrogram: this.showSpectrogram,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggleAdvancedSettings() {
    this.showAdvanced = !this.showAdvanced;
  }

  override render() {
    const cfg = this.config;
    const advancedClasses = classMap({
      'advanced-settings': true,
      'visible': this.showAdvanced,
    });
    const scaleMap = new Map<string, string>([
      ['Auto', 'SCALE_UNSPECIFIED'],
      ['C Major / A Minor', 'C_MAJOR_A_MINOR'],
      ['C# Major / A# Minor', 'D_FLAT_MAJOR_B_FLAT_MINOR'],
      ['D Major / B Minor', 'D_MAJOR_B_MINOR'],
      ['D# Major / C Minor', 'E_FLAT_MAJOR_C_MINOR'],
      ['E Major / C# Minor', 'E_MAJOR_D_FLAT_MINOR'],
      ['F Major / D Minor', 'F_MAJOR_D_MINOR'],
      ['F# Major / D# Minor', 'G_FLAT_MAJOR_E_FLAT_MINOR'],
      ['G Major / E Minor', 'G_MAJOR_E_MINOR'],
      ['G# Major / F Minor', 'A_FLAT_MAJOR_F_MINOR'],
      ['A Major / F# Minor', 'A_MAJOR_G_FLAT_MINOR'],
      ['A# Major / G Minor', 'B_FLAT_MAJOR_G_MINOR'],
      ['B Major / G# Minor', 'B_MAJOR_A_FLAT_MINOR'],
    ]);

    return html`
      <div class="core-settings-row">
        <div class="setting">
          <label for="temperature"
            >Temperature<span>${cfg.temperature!.toFixed(1)}</span></label
          >
          <input
            type="range"
            id="temperature"
            min="0"
            max="3"
            step="0.1"
            .value=${String(cfg.temperature!)}
            @input=${this.handleInputChange} />
        </div>
        <div class="setting">
          <label for="guidance"
            >Guidance<span>${cfg.guidance!.toFixed(1)}</span></label
          >
          <input
            type="range"
            id="guidance"
            min="0"
            max="6"
            step="0.1"
            .value=${String(cfg.guidance!)}
            @input=${this.handleInputChange} />
        </div>
        <div class="setting">
          <label for="topK">Top K<span>${cfg.topK}</span></label>
          <input
            type="range"
            id="topK"
            min="1"
            max="100"
            step="1"
            .value=${String(cfg.topK!)}
            @input=${this.handleInputChange} />
        </div>
      </div>
      <hr class="divider" />
      <div class=${advancedClasses}>
        <div class="setting">
          <label for="seed">Seed</label>
          <input
            type="number"
            id="seed"
            .value=${cfg.seed ?? ''}
            @input=${this.handleInputChange}
            placeholder="Auto" />
        </div>
        <div class="setting">
          <label for="bpm">BPM</label>
          <input
            type="number"
            id="bpm"
            min="60"
            max="180"
            .value=${cfg.bpm ?? ''}
            @input=${this.handleInputChange}
            placeholder="Auto" />
        </div>
        <div class="setting" .auto=${this.autoDensity}>
          <label for="density">Density</label>
          <input
            type="range"
            id="density"
            min="0"
            max="1"
            step="0.05"
            .value=${String(this.autoDensity ? (this.lastDefinedDensity ?? 0.5) : (cfg.density ?? 0.5))}
            @input=${this.handleInputChange} />
          <div class="auto-row">
            <input
              type="checkbox"
              id="auto-density"
              .checked=${this.autoDensity}
              @input=${this.handleInputChange} />
            <label for="auto-density">Auto</label>
            <span>${(this.autoDensity ? (this.lastDefinedDensity ?? 0.5) : (cfg.density ?? 0.5)).toFixed(2)}</span>
          </div>
        </div>
        <div class="setting" .auto=${this.autoBrightness}>
          <label for="brightness">Brightness</label>
          <input
            type="range"
            id="brightness"
            min="0"
            max="1"
            step="0.05"
            .value=${String(this.autoBrightness ? (this.lastDefinedBrightness ?? 0.5) : (cfg.brightness ?? 0.5))}
            @input=${this.handleInputChange} />
          <div class="auto-row">
            <input
              type="checkbox"
              id="auto-brightness"
              .checked=${this.autoBrightness}
              @input=${this.handleInputChange} />
            <label for="auto-brightness">Auto</label>
            <span>${(this.autoBrightness ? (this.lastDefinedBrightness ?? 0.5) : (cfg.brightness ?? 0.5)).toFixed(2)}</span>
          </div>
        </div>
        <div class="setting">
          <label for="scale">Scale</label>
          <select
            id="scale"
            .value=${cfg.scale || 'SCALE_UNSPECIFIED'}
            @change=${this.handleInputChange}>
            <option value="SCALE_UNSPECIFIED" ?selected=${!cfg.scale || cfg.scale === 'SCALE_UNSPECIFIED'}>Auto</option>
            ${[...scaleMap.entries()].filter(([name, val]) => val !== 'SCALE_UNSPECIFIED').map(
              ([displayName, enumValue]) =>
                html`<option value=${enumValue} ?selected=${cfg.scale === enumValue}>${displayName}</option>`,
            )}
          </select>
        </div>
        <div class="setting">
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="muteBass"
              .checked=${!!cfg.muteBass}
              @change=${this.handleInputChange} />
            <label for="muteBass" style="font-weight: normal;">Mute Bass</label>
          </div>
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="muteDrums"
              .checked=${!!cfg.muteDrums}
              @change=${this.handleInputChange} />
            <label for="muteDrums" style="font-weight: normal;"
              >Mute Drums</label
            >
          </div>
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="onlyBassAndDrums"
              .checked=${!!cfg.onlyBassAndDrums}
              @change=${this.handleInputChange} />
            <label for="onlyBassAndDrums" style="font-weight: normal;"
              >Only Bass & Drums</label
            >
          </div>
        </div>
        <div class="setting">
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="showSpectrogram"
              .checked=${this.showSpectrogram}
              @change=${this.handleInputChange} />
            <label for="showSpectrogram" style="font-weight: normal;">Show Spectrogram</label>
          </div>
        </div>
      </div>
      <div class="advanced-toggle" @click=${this.toggleAdvancedSettings}>
        ${this.showAdvanced ? 'Hide' : 'Show'} Advanced Settings
      </div>
    `;
  }
}

/** Spectrogram display component */
@customElement('spectrogram-display')
class SpectrogramDisplay extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 12vmin; /* Default height, can be overridden */
    }
    canvas {
      width: 100%;
      height: 100%;
      background-color: #080810; /* Dark background for spectrogram */
      display: block; /* Remove extra space below canvas */
      border-radius: 4px;
    }
  `;

  @property({attribute: false}) analyserNode: AnalyserNode | null = null;
  @property({type: String}) playbackState: PlaybackState = 'stopped';

  @query('canvas') private canvasEl!: HTMLCanvasElement;
  private canvasCtx!: CanvasRenderingContext2D | null;
  private frequencyDataArray: Uint8Array | null = null;
  private bufferLength = 0;
  private animationFrameId: number | null = null;


  override firstUpdated() {
    this.setupCanvas();
    this.startDrawingLoop();
  }

  override updated(changedProperties: Map<string | symbol, unknown>) {
    if (changedProperties.has('analyserNode') && this.analyserNode) {
      this.setupAnalyzer();
    }
    if (changedProperties.has('playbackState') || changedProperties.has('analyserNode')) {
        if (this.playbackState === 'playing' && this.analyserNode && !this.animationFrameId) {
            this.startDrawingLoop();
        }
    }
  }
  
  private setupCanvas() {
    if (!this.canvasEl) return;
    // Set canvas internal resolution based on its display size for crisp rendering
    this.canvasEl.width = this.canvasEl.offsetWidth;
    this.canvasEl.height = this.canvasEl.offsetHeight;
    this.canvasCtx = this.canvasEl.getContext('2d');
  }

  private setupAnalyzer() {
    if (this.analyserNode) {
      // analyserNode.fftSize is already set in PromptDj
      this.bufferLength = this.analyserNode.frequencyBinCount;
      this.frequencyDataArray = new Uint8Array(this.bufferLength);
    }
  }
  
  private startDrawingLoop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.draw();
  }

  private draw() {
    this.animationFrameId = requestAnimationFrame(this.draw.bind(this));

    if (
      !this.analyserNode ||
      !this.canvasCtx ||
      !this.canvasEl ||
      !this.frequencyDataArray
    ) {
      return;
    }
    
    if (this.playbackState !== 'playing') {
      // Optionally clear or show a paused state, for now, just stop drawing updates
      // If we want to clear:
      // this.canvasCtx.fillStyle = '#080810';
      // this.canvasCtx.fillRect(0, 0, this.canvasEl.width, this.canvasEl.height);
      return;
    }

    this.analyserNode.getByteFrequencyData(this.frequencyDataArray);

    const canvasWidth = this.canvasEl.width;
    const canvasHeight = this.canvasEl.height;

    // Shift existing content to the left by 1 pixel
    this.canvasCtx.drawImage(this.canvasEl, -1, 0, canvasWidth, canvasHeight);

    // Draw the new frequency data on the rightmost vertical line
    for (let y = 0; y < canvasHeight; y++) {
      // Map canvas y-coordinate (from bottom, y=0, to top, y=canvasHeight-1)
      // to a frequency bin index (from low frequency to high frequency).
      const binRatio = y / (canvasHeight - 1); // 0 (bottom) to 1 (top)
      const binIndex = Math.min(
        this.bufferLength - 1,
        Math.floor(binRatio * (this.bufferLength - 1))
      );

      const intensity = this.frequencyDataArray[binIndex];
      this.canvasCtx.fillStyle = this.getColorForIntensity(intensity);
      // Draw point at (canvasWidth-1, canvasHeight - 1 - y)
      // (canvasHeight - 1 - y) maps y=0 to the bottom row of the canvas.
      this.canvasCtx.fillRect(canvasWidth - 1, canvasHeight - 1 - y, 1, 1);
    }
  }

  private getColorForIntensity(intensity: number): string {
    // intensity is 0-255
    // Map intensity to HSL values:
    // Hue: 240 (blue) for low intensity, to 60 (yellow), then towards white
    // Saturation: High, decreases for very high intensity (towards white)
    // Lightness: Low for dark, increases with intensity

    if (intensity === 0) return '#080810'; // Match background for zero intensity

    let hue, saturation, lightness;

    if (intensity < 64) { // Dark blue to medium blue
        hue = 240;
        saturation = 100;
        lightness = 10 + (intensity / 63) * 30; // 10% to 40%
    } else if (intensity < 128) { // Medium blue to cyan
        hue = 240 - ((intensity - 64) / 63) * 60; // 240 down to 180
        saturation = 100;
        lightness = 40 + ((intensity - 64) / 63) * 20; // 40% to 60%
    } else if (intensity < 192) { // Cyan to green-yellow
        hue = 180 - ((intensity - 128) / 63) * 120; // 180 down to 60
        saturation = 100;
        lightness = 60 + ((intensity - 128) / 63) * 15; // 60% to 75%
    } else { // Green-yellow to bright yellow/white
        hue = 60;
        saturation = 100 - ((intensity - 192) / 63) * 50; // 100% down to 50%
        lightness = 75 + ((intensity - 192) / 63) * 20; // 75% to 95%
    }
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }
  
  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  override render() {
    return html`<canvas aria-label="Audio Spectrogram" role="img"></canvas>`;
  }
}


/** Component for the PromptDJ UI. */
@customElement('prompt-dj')
class PromptDj extends LitElement {
  static override styles = css`
    :host {
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      padding: 2vmin;
      position: relative;
      font-size: 1.8vmin;
    }
    #background {
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      background: #111;
    }
    .prompts-area {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      flex: 4; /* Adjusted flex factor */
      width: 100%;
      margin-top: 2vmin;
      gap: 2vmin;
      min-height: 25vmin; /* Ensure prompts area has some minimum height */
    }
    #prompts-container {
      display: flex;
      flex-direction: row;
      align-items: flex-end;
      flex-shrink: 1;
      height: 100%;
      gap: 2vmin;
      margin-left: 10vmin;
      padding: 1vmin;
      overflow-x: auto;
      scrollbar-width: thin;
      scrollbar-color: #666 #1a1a1a;
    }
    #prompts-container::-webkit-scrollbar {
      height: 8px;
    }
    #prompts-container::-webkit-scrollbar-track {
      background: #111;
      border-radius: 4px;
    }
    #prompts-container::-webkit-scrollbar-thumb {
      background-color: #666;
      border-radius: 4px;
    }
    #prompts-container::-webkit-scrollbar-thumb:hover {
      background-color: #777;
    }
    #prompts-container::before,
    #prompts-container::after {
      content: '';
      flex: 1;
      min-width: 0.5vmin;
    }
    .add-prompt-button-container {
      display: flex;
      align-items: flex-end;
      height: 100%;
      flex-shrink: 0;
    }
    #spectrogram-container { 
      width: 100%;
      margin: 1.5vmin 0;
      flex-shrink: 0; 
      min-height: 12vmin; 
    }
    #settings-container {
      flex: 1; /* Adjusted flex factor */
      margin: 1.5vmin 0;
      width: 100%;
      max-width: 90vmin; /* Limit width of settings */
      min-height: 10vmin; /* Ensure settings area has some minimum height */
    }
    .playback-container {
      display: flex;
      justify-content: center;
      align-items: center;
      flex-shrink: 0;
      margin-top: 1vmin;
    }
    play-pause-button,
    add-prompt-button,
    reset-button,
    record-button { /* Added record-button */
      width: 12vmin;
      flex-shrink: 0;
    }
    prompt-controller {
      height: 100%;
      max-height: 80vmin;
      min-width: 14vmin;
      max-width: 16vmin;
      flex: 1;
    }
  `;

  @property({
    type: Object,
    attribute: false,
  })
  private prompts: Map<string, Prompt>;
  private nextPromptId: number; // Monotonically increasing ID for new prompts
  private session!: LiveMusicSession; // Initialized in connectToSession
  private readonly sampleRate = 48000;
  private audioContext: AudioContext;
  private outputNode: GainNode;
  private analyserNode!: AnalyserNode; // Will be initialized in constructor
  private nextStartTime = 0;
  private readonly bufferTime = 2; // adds an audio buffer in case of netowrk latency
  @state() private playbackState: PlaybackState = 'stopped';
  @property({type: Object})
  private filteredPrompts = new Set<string>();
  private connectionError = true;
  @state() private displaySpectrogram = true;
  @state() private isRecording = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private mediaStreamDestination: MediaStreamAudioDestinationNode | null = null;


  @query('play-pause-button') private playPauseButton!: PlayPauseButton;
  @query('toast-message') private toastMessage!: ToastMessage;
  @query('settings-controller') private settingsController!: SettingsController;

  constructor(prompts: Map<string, Prompt>) {
    super();
    this.prompts = prompts;
    this.nextPromptId = this.prompts.size;

    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)(
      {sampleRate: this.sampleRate},
    );
    this.outputNode = this.audioContext.createGain();
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 1024; 
    
    this.outputNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioContext.destination);
  }

  override async firstUpdated() {
    await this.connectToSession();
    this.setSessionPrompts();
  }

  private async connectToSession() {
    try {
        this.session = await ai.live.music.connect({
        model: model,
        callbacks: {
            onmessage: async (e: LiveMusicServerMessage) => {
            console.log('Received message from the server: %s\n', e);
            if (e.setupComplete) {
                this.connectionError = false;
            }
            if (e.filteredPrompt) {
                this.filteredPrompts = new Set([
                ...this.filteredPrompts,
                e.filteredPrompt.text,
                ]);
                this.toastMessage.show(e.filteredPrompt.filteredReason);
            }
            if (e.serverContent?.audioChunks !== undefined) {
                if (
                this.playbackState === 'paused' ||
                this.playbackState === 'stopped'
                )
                return;
                const audioBuffer = await decodeAudioData(
                decode(e.serverContent?.audioChunks[0].data),
                this.audioContext,
                this.sampleRate, 
                2, 
                );
                const source = this.audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(this.outputNode); 
                if (this.nextStartTime === 0) {
                this.nextStartTime =
                    this.audioContext.currentTime + this.bufferTime;
                setTimeout(() => {
                    if(this.playbackState === 'loading') this.playbackState = 'playing';
                }, this.bufferTime * 1000);
                }

                if (this.nextStartTime < this.audioContext.currentTime) {
                console.log('Audio buffer underrun');
                this.playbackState = 'loading';
                this.nextStartTime = this.audioContext.currentTime + this.bufferTime; 
                }
                source.start(this.nextStartTime);
                this.nextStartTime += audioBuffer.duration;
            }
            },
            onerror: (e: ErrorEvent | Event) => { 
            console.error('Error occurred:', e);
            this.connectionError = true;
            this.stopAudio(); 
            this.toastMessage.show('Connection error. Please try restarting audio.');
            },
            onclose: (e: CloseEvent) => {
            console.log('Connection closed.', e);
            this.connectionError = true;
            if (this.playbackState !== 'stopped' && this.playbackState !== 'paused') {
               this.stopAudio(); 
            }
            this.toastMessage.show('Connection closed. Please try restarting audio.');
            },
        },
        });
        this.connectionError = false; 
    } catch (err) {
        console.error('Failed to connect to session:', err);
        this.connectionError = true;
        this.toastMessage.show('Failed to connect to music generation service.');
        this.playbackState = 'stopped';
    }
  }

  private setSessionPrompts = throttle(async () => {
    if (!this.session || this.connectionError) {
        console.warn("Session not available or connection error, skipping setSessionPrompts.");
        return;
    }
    const promptsToSend = Array.from(this.prompts.values()).filter((p) => {
      return !this.filteredPrompts.has(p.text) && p.weight !== 0;
    });
    try {
      await this.session.setWeightedPrompts({
        weightedPrompts: promptsToSend,
      });
    } catch (e: any) {
      this.toastMessage.show(e.message || 'Error setting prompts.');
      this.pauseAudio();
    }
  }, 200);

  private dispatchPromptsChange() {
    this.dispatchEvent(
      new CustomEvent('prompts-changed', {detail: this.prompts}),
    );
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const {promptId, text, weight} = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('prompt not found', promptId);
      return;
    }

    prompt.text = text;
    prompt.weight = weight;

    const newPrompts = new Map(this.prompts);
    newPrompts.set(promptId, prompt);

    this.prompts = newPrompts;

    this.setSessionPrompts();

    this.requestUpdate();
    this.dispatchPromptsChange();
  }

  /** Generates radial gradients for each prompt based on weight and color. */
  private makeBackground() {
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

    const MAX_WEIGHT = 0.5;
    const MAX_ALPHA = 0.6;

    const bg: string[] = [];

    [...this.prompts.values()].forEach((p, i) => {
      const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA;
      const alpha = Math.round(alphaPct * 0xff)
        .toString(16)
        .padStart(2, '0');

      const stop = p.weight / 2;
      const x = (i % 4) / 3;
      const y = Math.floor(i / 4) / 3;
      const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alpha} 0px, ${p.color}00 ${stop * 100}%)`;

      bg.push(s);
    });

    return bg.join(', ');
  }

  private async handlePlayPause() {
    if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
    }
    if (this.playbackState === 'playing') {
      this.pauseAudio();
    } else if (
      this.playbackState === 'paused' ||
      this.playbackState === 'stopped'
    ) {
      if (this.connectionError || !this.session) {
        this.playbackState = 'loading'; 
        await this.connectToSession();
        if (this.connectionError) { 
            this.playbackState = 'stopped'; 
            return;
        }
        this.setSessionPrompts(); 
      }
      this.loadAudio();
    } else if (this.playbackState === 'loading') {
      this.stopAudio(); 
    }
  }

  private pauseAudio() {
    if (this.session && !this.connectionError) this.session.pause();
    this.playbackState = 'paused';
    
    this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      0,
      this.audioContext.currentTime + 0.1,
    );
    
    this.outputNode.disconnect(); 
    this.outputNode = this.audioContext.createGain();
    this.outputNode.gain.value = 0; 
    this.outputNode.connect(this.analyserNode); 
    this.analyserNode.connect(this.audioContext.destination); // Reconnect analyser to destination
    
    this.nextStartTime = 0; 
  }

  private loadAudio() {
    if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
    }
    if (this.session && !this.connectionError) this.session.play();
    this.playbackState = 'loading';
    this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      1,
      this.audioContext.currentTime + 0.1,
    );
  }

  private stopAudio() {
    if (this.session && !this.connectionError) this.session.stop();
    this.playbackState = 'stopped';
    this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
        0, this.audioContext.currentTime + 0.05
    );
    this.nextStartTime = 0;
    this.outputNode.disconnect();
    this.outputNode = this.audioContext.createGain();
    this.outputNode.gain.value = 1; 
    this.outputNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioContext.destination); // Reconnect analyser to destination
  }

  private async handleAddPrompt() {
    const newPromptId = `prompt-${this.nextPromptId++}`;
    const usedColors = [...this.prompts.values()].map((p) => p.color);
    const newPrompt: Prompt = {
      promptId: newPromptId,
      text: PROMPT_TEXT_PRESETS[Math.floor(Math.random() * PROMPT_TEXT_PRESETS.length)], 
      weight: 0,
      color: getUnusedRandomColor(usedColors),
    };
    const newPrompts = new Map(this.prompts);
    newPrompts.set(newPromptId, newPrompt);
    this.prompts = newPrompts;

    this.setSessionPrompts(); 

    await this.updateComplete;

    const newPromptElement = this.renderRoot.querySelector<PromptController>(
      `prompt-controller[promptId="${newPromptId}"]`,
    );
    if (newPromptElement) {
      newPromptElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center', 
      });

      const textSpan =
        newPromptElement.shadowRoot?.querySelector<HTMLSpanElement>('#text');
      if (textSpan) {
        textSpan.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(textSpan);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
     this.dispatchPromptsChange(); 
  }

  private handlePromptRemoved(e: CustomEvent<string>) {
    e.stopPropagation();
    const promptIdToRemove = e.detail;
    if (this.prompts.has(promptIdToRemove)) {
      this.prompts.delete(promptIdToRemove);
      const newPrompts = new Map(this.prompts); 
      this.prompts = newPrompts;
      this.setSessionPrompts();
      this.dispatchPromptsChange(); 
    } else {
      console.warn(
        `Attempted to remove non-existent prompt ID: ${promptIdToRemove}`,
      );
    }
  }

  private handlePromptsContainerWheel(e: WheelEvent) {
    const container = e.currentTarget as HTMLElement;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      container.scrollLeft += e.deltaX;
    } else if (container.scrollWidth > container.clientWidth && e.deltaY !== 0) {
    }
  }

  private updateSettings = throttle(
    async (e: CustomEvent<SettingsControllerState>) => {
      this.displaySpectrogram = e.detail.showSpectrogram;
      const musicConfig = e.detail.musicGenerationConfig;

      if (!this.session || this.connectionError) return;
      try {
        await this.session.setMusicGenerationConfig({
            musicGenerationConfig: musicConfig,
        });
      } catch (err: any) {
          this.toastMessage.show(err.message || "Error updating settings.");
          console.error("Error setting music generation config:", err);
      }
    },
    200,
  );

  private async handleReset() {
    if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
    }
    if (this.connectionError || !this.session) {
      this.playbackState = 'loading';
      await this.connectToSession();
       if (this.connectionError) {
            this.playbackState = 'stopped';
            return;
        }
    }
    
    const wasPlaying = this.playbackState === 'playing' || this.playbackState === 'loading';
    
    this.pauseAudio(); 
    
    if (this.session && !this.connectionError) {
        this.session.resetContext();
    }
    
    this.settingsController.resetToDefaults(); 
    
    if (wasPlaying) {
        setTimeout(() => {
            if (this.playbackState === 'paused') { 
                 this.loadAudio();
            }
        }, 200); 
    }
  }

  private async handleRecordToggle() {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  private startRecording() {
    if (!MediaRecorder) {
      this.toastMessage.show('Recording is not supported by your browser.');
      console.error('MediaRecorder API not available.');
      return;
    }
    if (this.isRecording) return;

    try {
      this.mediaStreamDestination = this.audioContext.createMediaStreamDestination();
      this.outputNode.connect(this.mediaStreamDestination);

      // Determine a suitable MIME type
      const options = { mimeType: 'audio/webm; codecs=opus' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        console.warn(`${options.mimeType} is not supported, trying audio/webm (default)`);
        delete (options as any).mimeType; // Use browser default for audio/webm
         if (!MediaRecorder.isTypeSupported('audio/webm')) {
            console.warn(`audio/webm is not supported, trying audio/ogg; codecs=opus`);
            options.mimeType = 'audio/ogg; codecs=opus';
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                console.warn(`${options.mimeType} is not supported. Recording might fail or use a different format.`);
                delete (options as any).mimeType; // Fallback to browser default
            }
        }
      }
      
      this.mediaRecorder = new MediaRecorder(this.mediaStreamDestination.stream, options);
      this.recordedChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.saveRecording();
        // Disconnect after recording is fully stopped and saved
        if (this.mediaStreamDestination && this.outputNode.numberOfOutputs > 0) {
          try {
            this.outputNode.disconnect(this.mediaStreamDestination);
          } catch (e) {
            // Ignores if already disconnected or other errors
            console.warn('Error disconnecting output node from media stream destination:', e);
          }
        }
        this.mediaStreamDestination = null;
      };

      this.mediaRecorder.onerror = (event) => {
        console.error('MediaRecorder error:', event);
        this.toastMessage.show('Recording error occurred.');
        this.isRecording = false; // Reset state
         if (this.mediaStreamDestination && this.outputNode.numberOfOutputs > 0) {
           try {
            this.outputNode.disconnect(this.mediaStreamDestination);
           } catch(e) { /* ignore */ }
        }
        this.mediaStreamDestination = null;
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.toastMessage.show('Recording started...');
    } catch (e) {
      console.error('Failed to start recording:', e);
      this.toastMessage.show('Failed to start recording.');
      this.isRecording = false;
      if (this.mediaStreamDestination && this.outputNode.numberOfOutputs > 0) {
         try {
          this.outputNode.disconnect(this.mediaStreamDestination);
         } catch(err) { /* ignore */ }
      }
      this.mediaStreamDestination = null;
    }
  }

  private stopRecording() {
    if (!this.isRecording || !this.mediaRecorder) return;

    if (this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop(); // This will trigger 'onstop'
    }
    this.isRecording = false;
    // Do not disconnect here, do it in onstop to ensure all data is processed.
    this.toastMessage.show('Recording stopped. Preparing download...');
  }

  private saveRecording() {
    if (this.recordedChunks.length === 0) {
      console.warn('No audio data recorded.');
      this.toastMessage.show('No audio data was recorded.');
      return;
    }

    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(this.recordedChunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    document.body.appendChild(a);
    a.style.display = 'none';
    a.href = url;
    const extension = mimeType.includes('ogg') ? 'ogg' : 'webm';
    a.download = `prompt_dj_recording_${new Date().toISOString()}.${extension}`;
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    this.recordedChunks = [];
    this.toastMessage.show('Recording saved!');
  }


  override render() {
    const bg = styleMap({
      backgroundImage: this.makeBackground(),
    });
    return html`<div id="background" style=${bg}></div>
      <div class="prompts-area">
        <div
          id="prompts-container"
          @prompt-removed=${this.handlePromptRemoved}
          @wheel=${this.handlePromptsContainerWheel}>
          ${this.renderPrompts()}
        </div>
        <div class="add-prompt-button-container">
          <add-prompt-button @click=${this.handleAddPrompt}></add-prompt-button>
        </div>
      </div>

      ${this.displaySpectrogram
        ? html`
            <div id="spectrogram-container">
              <spectrogram-display
                .analyserNode=${this.analyserNode}
                .playbackState=${this.playbackState}
              ></spectrogram-display>
            </div>
          `
        : ''}
      
      <div id="settings-container">
        <settings-controller
          @settings-changed=${this.updateSettings}></settings-controller>
      </div>
      <div class="playback-container">
        <play-pause-button
          @click=${this.handlePlayPause}
          .playbackState=${this.playbackState}></play-pause-button>
        <record-button
          .recording=${this.isRecording}
          @click=${this.handleRecordToggle}></record-button>
        <reset-button @click=${this.handleReset}></reset-button>
      </div>
      <toast-message></toast-message>`;
  }

  private renderPrompts() {
    return [...this.prompts.values()].map((prompt) => {
      return html`<prompt-controller
        .promptId=${prompt.promptId}
        ?filtered=${this.filteredPrompts.has(prompt.text)}
        .text=${prompt.text}
        .weight=${prompt.weight}
        .color=${prompt.color}
        @prompt-changed=${this.handlePromptChanged}>
      </prompt-controller>`;
    });
  }
}

function gen(parent: HTMLElement) {
  const initialPrompts = getStoredPrompts();

  const pdj = new PromptDj(initialPrompts);
  pdj.addEventListener('prompts-changed', (e: Event) => {
      const customEvent = e as CustomEvent<Map<string, Prompt>>;
      setStoredPrompts(customEvent.detail);
  });
  parent.appendChild(pdj);
}

function getStoredPrompts(): Map<string, Prompt> {
  const {localStorage} = window;
  const storedPrompts = localStorage.getItem('prompts');

  if (storedPrompts) {
    try {
      const promptsArray = JSON.parse(storedPrompts) as Prompt[];
      console.log('Loading stored prompts', promptsArray);
      return new Map(promptsArray.map((prompt) => [prompt.promptId, prompt]));
    } catch (e) {
      console.error('Failed to parse stored prompts', e);
      localStorage.removeItem('prompts'); 
    }
  }

  console.log('No stored prompts, creating prompt presets');

  const numDefaultPrompts = Math.min(4, PROMPT_TEXT_PRESETS.length);
  const shuffledPresetTexts = [...PROMPT_TEXT_PRESETS].sort(
    () => Math.random() - 0.5,
  );
  const defaultPrompts: Prompt[] = [];
  const usedColors: string[] = [];
  for (let i = 0; i < numDefaultPrompts; i++) {
    const text = shuffledPresetTexts[i];
    const color = getUnusedRandomColor(usedColors);
    usedColors.push(color);
    defaultPrompts.push({
      promptId: `prompt-${i}`,
      text,
      weight: 0,
      color,
    });
  }
  const promptsToActivate = [...defaultPrompts].sort(() => Math.random() - 0.5);
  const numToActivate = Math.min(2, defaultPrompts.length);
  for (let i = 0; i < numToActivate; i++) {
    if (promptsToActivate[i]) {
      promptsToActivate[i].weight = 1;
    }
  }
  const initialMap = new Map(defaultPrompts.map((p) => [p.promptId, p]));
  setStoredPrompts(initialMap); 
  return initialMap;
}

function setStoredPrompts(prompts: Map<string, Prompt>) {
  const storedPrompts = JSON.stringify([...prompts.values()]);
  const {localStorage} = window;
  localStorage.setItem('prompts', storedPrompts);
}

function main(container: HTMLElement) {
  gen(container);
}

main(document.body);

declare global {
  interface HTMLElementTagNameMap {
    'prompt-dj': PromptDj;
    'prompt-controller': PromptController;
    'settings-controller': SettingsController;
    'add-prompt-button': AddPromptButton;
    'play-pause-button': PlayPauseButton;
    'reset-button': ResetButton;
    'record-button': RecordButton; // Added RecordButton
    'weight-slider': WeightSlider;
    'toast-message': ToastMessage;
    'spectrogram-display': SpectrogramDisplay; 
  }
}
