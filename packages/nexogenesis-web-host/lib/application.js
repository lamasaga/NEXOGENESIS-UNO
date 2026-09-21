import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function applicationIdentity(appRoot) {
    const canonicalRoot = resolve(appRoot).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
    return {
        product: "NEXOGENESIS-UNO",
        generation: "uno-bootstrap-v1",
        workspace_id: createHash("sha256").update(canonicalRoot).digest("hex"),
    };
}
