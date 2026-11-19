/** The moving dashed perimeter, shared by app and standalone chat switches. */
export function SealPending() {
  return (
    <svg className="lk-seal-pending" aria-hidden="true" focusable="false">
      <rect width="100%" height="100%" rx="5" pathLength="100" />
    </svg>
  );
}
