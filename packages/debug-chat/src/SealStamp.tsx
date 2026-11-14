/**
 * The two-part box seal inside a chat control (role="switch"), the widget's
 * copy of app/components/SealSwitch.tsx's SealStamp: the chat package has no
 * intlayer, so the two words come from its own strings. Both states always
 * show; the current one is pressed (styles: .lk-sealbox in app/globals.css).
 */
export function SealStamp({
  on,
  onWord,
  offWord,
  size = "sm",
}: {
  on: boolean;
  onWord: string;
  offWord: string;
  size?: "sm" | "md";
}) {
  return (
    <span aria-hidden="true" className="lk-sealbox" data-size={size} data-seal={on ? "on" : "off"}>
      <span data-word="on" data-active={on || undefined}>
        {onWord}
      </span>
      <span data-word="off" data-active={!on || undefined}>
        {offWord}
      </span>
    </span>
  );
}
