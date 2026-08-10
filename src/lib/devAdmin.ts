export const DEV_ADMIN_STORAGE_KEY = "elite-swap-dev-admin";

export function isDevAdminOverrideEnabled(
  search: string,
  storage: Storage = window.localStorage,
  isDev = import.meta.env.DEV,
) {
  const params = new URLSearchParams(search);
  if (params.get("devAdmin") === "1") return true;
  if (!isDev) return false;
  return storage.getItem(DEV_ADMIN_STORAGE_KEY) === "1";
}

export function setDevAdminOverride(enabled: boolean, storage: Storage = window.localStorage) {
  if (enabled) {
    storage.setItem(DEV_ADMIN_STORAGE_KEY, "1");
  } else {
    storage.removeItem(DEV_ADMIN_STORAGE_KEY);
  }
}

export function clearDevAdminOverride(storage: Storage = window.localStorage) {
  storage.removeItem(DEV_ADMIN_STORAGE_KEY);
}
