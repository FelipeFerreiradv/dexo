export interface AutoDescriptionParams {
  open: boolean;
  watchName: string | undefined | null;
  originalName: string | undefined | null;
  watchPartNumber?: string | undefined | null;
  originalPartNumber?: string | undefined | null;
  currentDescription?: string | undefined | null;
  defaultDescription?: string | undefined | null;
  dirtyName?: boolean;
  dirtyPartNumber?: boolean;
}

export function shouldApplyAutoDescription(params: AutoDescriptionParams) {
  const {
    open,
    watchName,
    originalName,
    watchPartNumber,
    originalPartNumber,
    currentDescription,
    defaultDescription,
    dirtyName = false,
    dirtyPartNumber = false,
  } = params;

  if (!open) return false;
  if (!watchName) return false;

  // If the user's default description is present in the form and the user
  // hasn't actually edited name/partNumber, do NOT overwrite it with
  // generated auto-description on dialog open.
  if (
    defaultDescription &&
    currentDescription === defaultDescription &&
    !dirtyName &&
    !dirtyPartNumber
  ) {
    return false;
  }

  const nameChanged = (watchName || "") !== (originalName || "");
  const partNumberChanged =
    (watchPartNumber || "") !== (originalPartNumber || "");

  return nameChanged || partNumberChanged;
}
