export function getSafeErrorMessage(code?: string): string {
  if (code === '23505') return 'This record already exists.';
  if (code === '23514') return 'Invalid value provided.';
  if (code === '42501') return 'You do not have permission to perform this action.';
  return 'Something went wrong. Please try again.';
}
