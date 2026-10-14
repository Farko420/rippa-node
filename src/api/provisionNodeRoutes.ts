import { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { env } from "../config";
import {
  SUPPORTED_PROVISION_PLATFORMS,
  buildNodeProvisionBundle,
  buildProvisionConfig,
  normalizeProvisionPlatform,
  type ProvisionNodeInput,
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
 * TWO TRANSPORTS, ONE MINTED IDENTITY. Whichever transport a caller picks, the
 * node record itself (its permanent node code and its per-node API key) is
 * minted through the SAME {@link buildProvisionConfig}, so an Android node and a
 * Windows node are indistinguishable in the fleet registry.
 *
 *   - WINDOWS DESKTOP — a machine with a filesystem, a browser and an unzip
 *     tool. It gets the archive ITSELF (`application/zip`): a 100 MB executable
 *     base64-encoded into a JSON envelope would inflate to ~133 MB, blow past
 *     every sane response limit and have to be decoded again by the caller.
 *     {@link buildNodeProvisionBundle} resolves the platform's release artefact
 *     through the same GitHub asset resolver the desktop build uses and zips it
 *     with the generated `config.json`, exactly as before.
 *   - ANDROID — a mobile app that downloads the raw APK from GitHub itself and
 *     cannot read a side-loaded zipped `config.json`. It asks only for the
 *     connection credentials and gets them as JSON. Nothing is fetched from
 *     GitHub and no archive is built, so the response is instant and small.
 *
 * JSON is returned when the platform is `android` OR the request carries
 * `Accept: application/json` (so a scripted caller can ask for credentials for
 * any platform). Everything else — in practice a Windows desktop node — keeps
 * the zip flow byte-for-byte.
 *
 * ERRORS ARE ALWAYS JSON, because a failure has to be readable — which is also
 * why the status code distinguishes "you asked wrong" (400) from "GitHub would
 * not give us the artefact" (502).
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

/**
 * True when the caller asked for a JSON body rather than the zip archive.
 *
 * ONLY AN EXPLICIT `application/json` COUNTS. A wildcard Accept (what curl and
 * most HTTP clients send by default) must not be treated as "give me JSON": that
 * would silently swap the Windows desktop's executable for two strings — a
 * download that appears to succeed and produces a file Windows refuses to run.
 * The zip stays the default; JSON has to be asked for, or implied by `android`.
 */
function acceptsJsonResponse(req: Request): boolean {
  return (req.get("accept") ?? "").includes("application/json");
}

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

    const provisionInput: ProvisionNodeInput = {
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
    };

    // JSON TRANSPORT — Android, or any caller that explicitly asked for JSON.
    // The node record is minted through the SAME `buildProvisionConfig` the zip
    // path uses, so the node code and API key are generated exactly as before;
    // the release artefact is simply never resolved, downloaded or zipped. The
    // mobile app fetches the raw APK from GitHub itself and only needs the
    // credentials that point it back at this Master.
    if (platform === "android" || acceptsJsonResponse(req)) {
      try {
        const { config, nodeCode } = buildProvisionConfig(provisionInput);
        console.log(
          `[Provision] Issued ${platform} credentials for node ${nodeCode} as JSON ` +
            `(no artefact fetched).`,
        );
        res.status(200).json({
          apiKey: config.NODE_API_KEY,
          url: config.MOTHERSHIP_URL,
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          platform,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    try {
      const bundle = await buildNodeProvisionBundle(provisionInput);

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
