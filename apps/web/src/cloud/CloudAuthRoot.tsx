import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "./managedAuth";

export default function CloudAuthRoot({
  children,
  publishableKey,
}: {
  readonly children: ReactNode;
  readonly publishableKey: string;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
