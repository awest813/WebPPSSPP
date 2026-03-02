/// <reference types="vite/client" />

interface Window {
  __onLaunchGame?: (file: File, systemId: string) => Promise<void>;
}
