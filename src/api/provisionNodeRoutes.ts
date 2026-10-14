import { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { env } from "../config";
import {
  SUPPORTED_PROVISION_PLATFORMS,
  buildNodeProvisionBundle,
  normalizeProvisionPlatform,
} from "../services/nodeProvisioner";

/**
 * `POST /api/admin/provision-node` — mint a ready-to-run node bundle.
 *
 * WHY THE ENDPOINT EXISTS. Provisioning a satellite by hand means fetching the
 * right release artefact, minting a node code, copying this node's mesh key,
 * writing a `config.json` with all of the above and getting the file onto the
 * target machine — four steps, three of which are easy to get subtly wrong, and
 * a wrong `config.json` is not a visible error: the node just boots into Setup
 * and sits there. This endpoint collapses it into one authenticated POST that
 * returns a `.zip` containing the artefact and the config, ready to drop on the
 * machine.
 *
 * ONE FLOW, EVERY PLATFORM. `android` is not a special case in the handler: the
 * platform is validated, normalised and handed to
 * {@link buildNodeProvisionBundle}, which resolves the platform's release
 * artefact through the same GitHub asset resolver the desktop build uses and
 * zips it with the same generated `config.json`. The desktop and Android paths
 * differ only in the asset names and extension fallback declared in
 * `update/githubAsset.ts`.
 *
 * TRANSPORT. A successful response is the archive ITSELF (`application/zip`),
 * not a JSON envelope around base64: a 100 MB executable base64-encoded would
 * inflate to ~133 MB, blow past every sane response limit and have to be decoded
 * again by the caller. Errors are JSON, because a failure has to be readable —
 * which is also why the status code distinguishes "you asked wrong" (400) from
 * "GitHub would not give us the artefact" (502).
 */

/**
 * Request body. Every field is optional except the platform, and every field is
 * bounded — this body is echoed into a file that lands on another machine.
 */
const provisionNodeSchema = z.object({
  // `platform` is the documented name; `os` is accepted because the same idea is
  // spelled both ways in operator requests and neither is wrong.
  platform: z.string().trim().max(32).optional(),
  os: z.string().trim().max(32).optional(),
  nodeName: z.string().trim().max(120).optional(),
  nodeCode: z.string().trim().max(64).optional(),
  role: z.enum(["master", "satellite"]).optional(),
  masterUrl: z.string().trim().max(2048).optional(),
  mothershipUrl: z.string().trim().max(2048).optional(),
  dashboardPin: z.string().trim().min(4).max(64).optional(),
  meshKey: z.string().trim().max(512).optional(),
  pairWithMaster: z.boolean().optional(),
  masterCode: z.string().trim().max(64).optional(),
});

export function registerProvisionNodeRoutes(
  r: Router,
  auth: (req: Request, res: Response, next: () => void) => void,
): void {
  r.post("/api/admin/provision-node", auth, async (req: Request, res: Response) => {
    // Master-only, matching every other /api/admin route: the mesh key and the
    // Master address this bundle embeds are the Master's to hand out.
    if (env.NODE_ROLE !== "master") {
      res.status(400).json({ success: false, message: "Not a Master." });
      return;
    }

    const parsed = provisionNodeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: "Invalid provisioning request.",
        issues: parsed.error.issues.map((issue) => issue.message),
      });
      return;
    }

    const requested = parsed.data.platform ?? parsed.data.os;
    const platform = normalizeProvisionPlatform(requested);
    if (!platform) {
      // Name the supported set rather than echoing the rejected value alone: the
      // usual cause is `win32`/`darwin` (the HOST's vocabulary) and the fix is
      // obvious once the accepted names are on screen.
      res.status(400).json({
        success: false,
        message:
          `Unsupported platform "${String(requested ?? "")}". ` +
          `Supported: ${SUPPORTED_PROVISION_PLATFORMS.join(", ")}.`,
        platforms: SUPPORTED_PROVISION_PLATFORMS,
      });
      return;
    }

    try {
      const bundle = await buildNodeProvisionBundle({
        platform,
        nodeName: parsed.data.nodeName,
        nodeCode: parsed.data.nodeCode,
        role: parsed.data.role,
        masterUrl: parsed.data.masterUrl,
        mothershipUrl: parsed.data.mothershipUrl,
        dashboardPin: parsed.data.dashboardPin,
        meshKey: parsed.data.meshKey,
        pairWithMaster: parsed.data.pairWithMaster,
        masterCode: parsed.data.masterCode,
      });

      console.log(
        `[Provision] Bundled ${bundle.platform} node ${bundle.config.NODE_CODE} ` +
          `(${bundle.assetName}, ${bundle.bytes.length} bytes) from ${bundle.sourceUrl}`,
      );

      res.status(200);
      res.setHeader("Content-Type", "application/zip");
      // The filename is safe by construction (the platform is from a closed set
      // and the node code is `RIPPA-XXXX-XXXX`), so it can neither break the
      // header nor escape the operator's download folder.
      res.setHeader("Content-Disposition", `attachment; filename="${bundle.filename}"`);
      res.setHeader("Content-Length", String(bundle.bytes.length));
      // Diagnostic headers so a scripted caller can confirm WHICH artefact it
      // received without unzipping 100 MB.
      res.setHeader("X-Rippa-Node-Platform", bundle.platform);
      res.setHeader("X-Rippa-Node-Asset", bundle.assetName);
      res.setHeader("X-Rippa-Node-Code", bundle.config.NODE_CODE ?? "");
      res.end(bundle.bytes);
    } catch (error) {
      // 502, not 500: the failure is upstream (GitHub would not hand over the
      // artefact), and the message already names the cause and the assets tried.
      res.status(502).json({
        success: false,
        platform,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
