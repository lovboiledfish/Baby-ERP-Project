import { createContext, useContext } from 'react';

export interface Me {
  user_name: string;
  sys_id: string | null;
  roles: string[];
  groups: string[];
  impersonated_by: { user_name: string; sys_id: string } | null;
}

export interface NavTable {
  name: string;
  label: string;
  extends: string | null;
}

export interface AppState {
  me: Me;
  isAdmin: boolean;
  tables: NavTable[];
  /** Re-fetch the navigator (after creating a table, impersonating, ...). */
  reloadNav: () => void;
  /** Re-fetch who we are (after impersonation changes). */
  reloadMe: () => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp outside of <AppContext.Provider>');
  return ctx;
}
