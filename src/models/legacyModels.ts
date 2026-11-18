/** Lifecycle metadata never hides a model shipped by the fork. */
export function isListedModel(
  _model: { legacy?: boolean },
  _isSelected: boolean,
  _isDownloaded = false
): boolean {
  return true;
}
