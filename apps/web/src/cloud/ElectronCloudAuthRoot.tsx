import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "./managedAuth";

export default function ElectronCloudAuthRoot({
  children,
  publishableKey,
}: {
  readonly children: ReactNode;
  readonly publishableKey: string;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey} passkeys={passkeys}>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
