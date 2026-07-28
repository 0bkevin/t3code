import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListTodoIcon, PaperclipIcon } from "lucide-react";
import { Button } from "../ui/button";
import { HermesIcon } from "../HermesIcon";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  /**
   * Mirrors the wide-layout gate in `ComposerFooterModeControls`. Both call
   * sites must be gated or the runtime-mode control survives at narrow widths.
   */
  showRuntimeModeSelector: boolean;
  /**
   * Mirrors the wide-layout agent button. Null when this composer's provider
   * has no agent page to open.
   */
  onOpenAgent: (() => void) | null;
  /**
   * Mirrors the wide-layout paperclip. Null when this composer's provider
   * takes images through drag/paste only (everything but Hermes).
   */
  onAttachFiles: (() => void) | null;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            {/* Trailing rule only when something follows it — the plan item
                brings its own leading divider. */}
            {props.showRuntimeModeSelector ? <MenuDivider /> : null}
          </>
        ) : null}
        {props.showRuntimeModeSelector ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
            <MenuRadioGroup
              value={props.runtimeMode}
              onValueChange={(value) => {
                if (!value || value === props.runtimeMode) return;
                props.onRuntimeModeChange(value as RuntimeMode);
              }}
            >
              <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
              <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
              <MenuRadioItem value="auto">Auto</MenuRadioItem>
              <MenuRadioItem value="full-access">Full access</MenuRadioItem>
            </MenuRadioGroup>
          </>
        ) : null}
        {props.onAttachFiles ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onAttachFiles}>
              <PaperclipIcon className="size-4 shrink-0" />
              Attach files
            </MenuItem>
          </>
        ) : null}
        {props.onOpenAgent ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onOpenAgent}>
              <HermesIcon className="size-4 shrink-0" />
              Agent details
            </MenuItem>
          </>
        ) : null}
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
