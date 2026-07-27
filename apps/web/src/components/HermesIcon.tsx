import type { Icon } from "./Icons";

/**
 * The Hermes Agent brand mark (the Nous mascot), served from our own public
 * dir rather than hotlinked. Typed as `Icon` so every provider-icon registry
 * and call site keeps working unchanged; the SVG-flavored props degrade to
 * the `img` cleanly since only `className`/`style` are ever passed.
 *
 * The source art is black-on-white inside a rounded tile, so `currentColor`
 * theming does not apply — the rounded corners are baked into the asset.
 */
export const HermesIcon: Icon = ({ className, style }) => (
  <img
    src="/hermes-agent-icon.png"
    alt=""
    aria-hidden
    draggable={false}
    className={className}
    style={style}
  />
);
