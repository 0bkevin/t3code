import type { VoiceTranscriptionProvider } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  useClientSettings,
  useSidebarV2Enabled,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const AUTO_SETTLE_MIN_DAYS = 1;
const AUTO_SETTLE_MAX_DAYS = 90;
const AUTO_SETTLE_DEFAULT_DAYS = 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      type="number"
      min={AUTO_SETTLE_MIN_DAYS}
      max={AUTO_SETTLE_MAX_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= AUTO_SETTLE_MIN_DAYS &&
          parsed <= AUTO_SETTLE_MAX_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Days of inactivity before auto-settle"
    />
  );
}

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useSidebarV2Enabled();
  const sidebarAutoSettleAfterDays = useClientSettings(
    (settings) => settings.sidebarAutoSettleAfterDays,
  );
  const voiceTranscriptionEnabled = useClientSettings(
    (settings) => settings.voiceTranscriptionEnabled,
  );
  const voiceTranscriptionProvider = useClientSettings(
    (settings) => settings.voiceTranscriptionProvider,
  );
  const voiceTranscriptionApiKey = useClientSettings(
    (settings) => settings.voiceTranscriptionApiKey,
  );
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          {...searchableSetting("sidebar-v2")}
          description="One flat thread list in creation order. Active work renders as rich cards; settled threads collapse to compact rows. Settling requires an up-to-date server — on older servers threads simply stay active. Switch back any time."
          control={
            <Switch
              checked={sidebarV2Enabled}
              // Touching the switch pins the choice, so a nightly build that
              // defaults v2 on does not flip it back after the user opts out.
              onCheckedChange={(checked) =>
                updateSettings({
                  sidebarV2Enabled: Boolean(checked),
                  sidebarV2ConfiguredByUser: true,
                })
              }
              aria-label="Enable the sidebar v2 beta"
            />
          }
        />
        {sidebarV2Enabled ? (
          <>
            <SettingsRow
              title={searchableSetting("auto-settle-inactive-threads").title}
              description="Threads with no activity for this long settle automatically. Threads on merged or closed PRs always settle."
              control={
                <Switch
                  checked={sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="Auto-settle inactive threads"
                />
              }
            />
            {sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                title="Days of inactivity before auto-settle"
                description="Any new activity un-settles a thread automatically."
                control={
                  <AutoSettleDaysInput
                    value={sidebarAutoSettleAfterDays}
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}
          </>
        ) : null}
        <SettingsRow
          {...searchableSetting("voice-dictation")}
          description="Record from the composer and turn speech into text. Uses portable browser media APIs on Linux, macOS, and Windows."
          control={
            <Switch
              checked={voiceTranscriptionEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ voiceTranscriptionEnabled: Boolean(checked) })
              }
              aria-label="Enable voice dictation beta"
            />
          }
        />
        {voiceTranscriptionEnabled ? (
          <>
            <SettingsRow
              title="Transcription provider"
              description="Use your own OpenAI or Groq key. OpenAI is the default."
              control={
                <Select
                  value={voiceTranscriptionProvider}
                  onValueChange={(value) =>
                    updateSettings({
                      voiceTranscriptionProvider: value as VoiceTranscriptionProvider,
                      voiceTranscriptionApiKey: "",
                    })
                  }
                >
                  <SelectTrigger className="w-full sm:w-44" aria-label="Transcription provider">
                    <SelectValue>
                      {voiceTranscriptionProvider === "openai" ? "OpenAI" : "Groq"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="openai">
                      OpenAI
                    </SelectItem>
                    <SelectItem hideIndicator value="groq">
                      Groq
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title={`${voiceTranscriptionProvider === "openai" ? "OpenAI" : "Groq"} API key`}
              description="Stored only in this client's local settings and sent directly to the selected provider through your local t3code server."
              control={
                <Input
                  type="password"
                  autoComplete="off"
                  className="w-full sm:w-64"
                  value={voiceTranscriptionApiKey}
                  onChange={(event) =>
                    updateSettings({ voiceTranscriptionApiKey: event.target.value })
                  }
                  placeholder="Required"
                  aria-label="Transcription API key"
                />
              }
            />
          </>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
