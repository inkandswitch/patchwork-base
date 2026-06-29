/**
 * A skeleton row shown by a Suspense boundary while a document or folder's
 * handle is still loading, so items can stream in instead of the whole list
 * appearing at once.
 */
export function LoadingRow(props: { depth?: number }) {
  return (
    <div
      class="document-list-item document-list-item--loading"
      style={{ "--depth": props.depth ?? 0 }}
      aria-hidden="true"
    >
      <span class="document-list-item__skeleton" />
    </div>
  );
}
