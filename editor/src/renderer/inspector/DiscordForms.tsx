import { useEffect, useState } from 'react';
import type { DiscordList } from '../../../../src/control/protocol.js';
import type { ButtonDef } from '../../../../src/types.js';
import type { PairIconField } from '../../shared/icons.js';
import { actionOf, Checkbox, nextAction, NumberSetting, Row, Segmented, StateIcons, type FormProps } from './controls.js';

/**
 * The Discord keys. What a key acts on is **picked from Discord's own
 * lists, never typed**, as OBS's and VTube Studio's are: a mistyped ID would
 * only fail later, on the deck. With Discord not running there is nothing to
 * pick from — "Start Discord to choose" — and a saved choice is always kept
 * and shown.
 *
 * Stored by ID; the names are written beside the IDs only to show here and
 * in what the key says when it fails.
 */

const ABOUT: Record<string, { heading: string; text: string }> = {
  'discord.mute': { heading: 'Mute', text: 'Mutes or unmutes your microphone in Discord. The key shows which, from Discord itself — a mute clicked in Discord shows too.' },
  'discord.deafen': { heading: 'Deafen', text: 'Deafens or undeafens you in Discord; Discord mutes you with it. The key shows which, from Discord itself.' },
  'discord.inputMode': {
    heading: 'Input mode',
    text: 'Switches Discord between push-to-talk and voice activity, keeping the rest of your voice settings. The key shows the mode Discord is in.',
  },
  'discord.leave': { heading: 'Leave channel', text: 'Leaves the Discord voice channel you are in. In none, it does nothing.' },
};

/** The note every Discord form ends with: where Discord is set up, and that it can be slow to answer. */
function Needs() {
  return (
    <p className="muted small">
      Needs the Discord app running, and Discord connected in Deckhand's{' '}
      <button className="link-button" onClick={() => void window.deckhand.openSettings('discord')}>
        Settings › Integrations
      </button>
      . Discord can take a few seconds to answer when it starts or the profile changes; until then the key shows it is connecting.
    </p>
  );
}

/** discord.mute, discord.deafen, discord.inputMode, discord.leave: nothing to set. */
export function DiscordForm({ type, button, disabled, onChooseIcon }: { type: string; button?: ButtonDef; disabled?: boolean; onChooseIcon?: (field: PairIconField | null) => void }) {
  const about = ABOUT[type];
  if (!about) return null;
  return (
    <section className="inspector-section">
      <h3 className="section-heading">{about.heading}</h3>
      <p className="muted small">{about.text}</p>
      {/* Mute, Deafen and Input mode: an icon of your own for each state; Leave has one face. */}
      <StateIcons type={type} button={button} disabled={disabled ?? false} onChooseIcon={onChooseIcon} />
      <Needs />
    </section>
  );
}

/** Discord's list for a picker, asked when the form opens, when its server changes, and on Ask again. Null while asking. */
function useDiscordList(kind: 'guilds' | 'channels' | 'users', guild: string | null, ask: number): DiscordList | null {
  const [list, setList] = useState<DiscordList | null>(null);
  useEffect(() => {
    let alive = true;
    setList(null);
    if (kind === 'channels' && !guild) return;
    void window.deckhand.discordList(kind, guild ?? undefined).then((l) => alive && setList(l));
    return () => {
      alive = false;
    };
  }, [kind, guild, ask]);
  return list;
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * One item from Discord's list, by ID. A saved one Discord does not list is
 * kept, shown first by its saved name and marked; with Discord not
 * reachable, the saved one is still shown, and nothing else can be picked.
 */
function IdPicker({
  list,
  stored,
  storedName,
  what,
  missing,
  disabled,
  onChoose,
  onRefresh,
}: {
  list: DiscordList | null;
  stored: string | null;
  storedName: string | null;
  /** "server", "voice channel", "person": for the words. */
  what: string;
  /** What a saved one Discord does not list now is said to be. */
  missing: string;
  disabled: boolean;
  onChoose: (item: { id: string; name: string }) => void;
  onRefresh: () => void;
}) {
  const items = list?.ok ? list.items : [];
  const storedMissing = stored !== null && list?.ok === true && !items.some((i) => i.id === stored);
  const kept = stored !== null && (list === null || !list.ok || storedMissing);
  return (
    <>
      <ul className="target-list" data-discord-picker={what}>
        {kept && (
          <li>
            <button className="target target-selected" disabled data-discord-id={stored}>
              <span className="target-name">{storedName ?? stored}</span>
              {storedMissing && <span className="target-note">{missing}</span>}
            </button>
          </li>
        )}
        {items.map((item) => (
          <li key={item.id}>
            <button className={stored === item.id ? 'target target-selected' : 'target'} disabled={disabled} onClick={() => onChoose(item)} data-discord-id={item.id}>
              <span className="target-name">{item.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {list === null && <p className="muted small">Asking Discord… it can take a few seconds to answer.</p>}
      {list?.ok === false && (
        <p className="warning-text" data-discord-list={list.reason}>
          {list.reason === 'unavailable' ? 'Start Discord to choose.' : list.message}
        </p>
      )}
      {list?.ok === true && items.length === 0 && <p className="muted small">Discord has no {what}s to choose from here.</p>}
      {stored === null && list?.ok === true && items.length > 0 && <p className="muted small">Pick the {what} for this key.</p>}
      <button className="link-button" onClick={onRefresh} data-discord-refresh={what}>
        Ask Discord again
      </button>
    </>
  );
}

/** discord.join: join a voice channel — the server first, then its voice channels. */
export function DiscordJoinForm({ at, button, disabled, run }: FormProps) {
  const [ask, setAsk] = useState(0);
  const action = actionOf('discord.join', button);
  const storedGuild = text(action?.guild);
  // A server picked, not yet written: the channel list follows it until a channel is chosen.
  const [guild, setGuild] = useState<{ id: string; name: string } | null>(storedGuild ? { id: storedGuild, name: text(action?.guildName) ?? storedGuild } : null);
  const guilds = useDiscordList('guilds', null, ask);
  const channels = useDiscordList('channels', guild?.id ?? null, ask);
  return (
    <section className="inspector-section">
      <h3 className="section-heading">Join channel</h3>
      <p className="muted small">Joins a Discord voice channel, moving you from the one you are in. In it already, the key does nothing.</p>
      <h4 className="form-subheading">Server</h4>
      <IdPicker
        list={guilds}
        stored={guild?.id ?? null}
        storedName={guild?.name ?? null}
        what="server"
        missing="not one of your servers now"
        disabled={disabled}
        onChoose={setGuild}
        onRefresh={() => setAsk((n) => n + 1)}
      />
      {guild !== null && (
        <>
          <h4 className="form-subheading">Voice channel</h4>
          <IdPicker
            list={channels}
            stored={guild.id === storedGuild ? text(action?.channel) : null}
            storedName={guild.id === storedGuild ? text(action?.channelName) : null}
            what="voice channel"
            missing="not in Discord now"
            disabled={disabled}
            onChoose={(channel) =>
              void run({
                kind: 'setAction',
                at,
                action: nextAction('discord.join', button, { guild: guild.id, guildName: guild.name, channel: channel.id, channelName: channel.name }),
              })
            }
            onRefresh={() => setAsk((n) => n + 1)}
          />
        </>
      )}
      <Needs />
    </section>
  );
}

/**
 * discord.userVolume: make one person louder or quieter, for you — as
 * Volume nudges the output, by a step, within Discord's 0–200 %. The person
 * is picked from the voice channel you are in now.
 */
export function DiscordUserVolumeForm({ at, button, disabled, run }: FormProps) {
  const [ask, setAsk] = useState(0);
  const action = actionOf('discord.userVolume', button);
  // The daemon's default is +5, as Volume's is.
  const delta = typeof action?.delta === 'number' ? action.delta : 5;
  const step = Math.abs(delta);
  const up = delta >= 0;
  const users = useDiscordList('users', null, ask);
  const write = (patch: Record<string, unknown>) => void run({ kind: 'setAction', at, action: nextAction('discord.userVolume', button, patch) });
  return (
    <section className="inspector-section">
      <h3 className="section-heading">User volume</h3>
      <p className="muted small">
        Makes one person louder or quieter — only for you, as Discord’s own volume slider for them does, from 0 to 200 %. They have to be in the voice channel
        you are in when you press it.
      </p>
      <h4 className="form-subheading">Person</h4>
      <IdPicker
        list={users}
        stored={text(action?.user)}
        storedName={text(action?.userName)}
        what="person"
        missing="not in your voice channel now"
        disabled={disabled}
        onChoose={(user) => write({ user: user.id, userName: user.name })}
        onRefresh={() => setAsk((n) => n + 1)}
      />
      <Segmented
        label="Volume"
        options={[
          { value: 'up', label: 'Louder' },
          { value: 'down', label: 'Quieter' },
        ]}
        value={up ? 'up' : 'down'}
        disabled={disabled}
        onChoose={(v) => write({ delta: v === 'up' ? step : -step })}
      />
      <Row name="By">
        <NumberSetting label="Volume step" value={step} min={1} max={200} disabled={disabled} onSave={(n) => write({ delta: up ? n : -n })} />
        <span className="form-value">%</span>
      </Row>
      <Checkbox label="Show the level on the key" checked={action?.showLevel === true} disabled={disabled} onChange={(on) => write({ showLevel: on ? true : undefined })} />
      <Needs />
    </section>
  );
}
