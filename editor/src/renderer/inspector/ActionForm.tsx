import type { ButtonDef } from '../../../../src/types.js';
import type { ButtonLocation, Edit } from '../../shared/edits.js';
import type { PairIconField } from '../../shared/icons.js';
import type { Choice } from '../model.js';
import { MuteForm, VolumeForm } from './AudioForms.js';
import { CycleForm, CycleInputsForm, InputForm, OutputForm, type AudioLists } from './DeviceForms.js';
import { HotkeyForm, PressReleaseForm, ToggleForm } from './HotkeyForm.js';
import { MediaControlForm, MediaInfoForm } from './MediaForms.js';
import { MultiForm } from './MultiForm.js';
import { PageAction } from './PageAction.js';
import { ProfileAction } from './ProfileAction.js';
import { BrightnessForm, ClockForm, NoopForm } from './SystemForms.js';
import { CommandForm, TextForm } from './TextCommandForms.js';

/** What every form may need; each takes the parts it uses. */
export interface ActionFormProps {
  type: string;
  at: ButtonLocation;
  /** The key — or, for a Multi action step, a stand-in holding just that step as its action. */
  button: ButtonDef | undefined;
  disabled: boolean;
  run: (edit: Edit) => Promise<boolean>;
  pages: Choice[];
  profiles: Choice[];
  coverage: (profile: string) => { covered: string[]; uncoveredConnected: string[] };
  audio: AudioLists;
  /** Start listening (Hotkey, Press/Release): a library pick; handed back once taken. */
  listenRequest: boolean;
  onListening: () => void;
  /** Open the Icon tab on a state icon; absent for a Multi step, which has no face. */
  onChooseIcon?: (field: PairIconField) => void;
  /** The deck, for Multi action's Test Run. */
  serial: string;
  canTestRun: boolean;
}

/** The form for one action type (one file per library group in inspector/), or null if there is none. */
export function ActionForm(p: ActionFormProps) {
  const common = { at: p.at, button: p.button, disabled: p.disabled, run: p.run };
  switch (p.type) {
    case 'hotkey':
      return <HotkeyForm at={p.at} button={p.button} editingBlocked={p.disabled} run={p.run} listenRequest={p.listenRequest} onListening={p.onListening} />;
    case 'keyHold':
      return <PressReleaseForm at={p.at} button={p.button} editingBlocked={p.disabled} run={p.run} listenRequest={p.listenRequest} onListening={p.onListening} />;
    case 'toggle':
      return <ToggleForm at={p.at} button={p.button} editingBlocked={p.disabled} run={p.run} listenRequest={p.listenRequest} onListening={p.onListening} />;
    case 'text':
      return <TextForm {...common} />;
    case 'command':
      return <CommandForm {...common} />;
    case 'multi':
      return <MultiForm {...p} />;
    case 'page':
      return <PageAction at={p.at} action={p.button?.action} pages={p.pages} disabled={p.disabled} run={p.run} />;
    case 'profile':
      return <ProfileAction at={p.at} action={p.button?.action} profiles={p.profiles} coverage={p.coverage} disabled={p.disabled} run={p.run} />;
    case 'clock':
      return <ClockForm {...common} />;
    case 'noop':
      return <NoopForm />;
    case 'brightness':
      return <BrightnessForm {...common} />;
    case 'media.control':
      return <MediaControlForm {...common} onChooseIcon={p.onChooseIcon} />;
    case 'media.info':
      return <MediaInfoForm {...common} />;
    case 'audio.volume':
      return <VolumeForm {...common} />;
    case 'audio.micMute':
    case 'audio.mute':
      return <MuteForm type={p.type} {...common} onChooseIcon={p.onChooseIcon} />;
    case 'audio.sink':
      return <OutputForm {...common} audio={p.audio} />;
    case 'audio.source':
      return <InputForm {...common} audio={p.audio} />;
    case 'audio.cycle':
      return <CycleForm {...common} audio={p.audio} />;
    case 'audio.cycleSource':
      return <CycleInputsForm {...common} audio={p.audio} />;
    default:
      return null;
  }
}
