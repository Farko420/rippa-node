import { type Request, type Response, type Router } from "express";
import { z } from "zod";
import {
  getAutoPublishedPlaces,
  getReviewQueuePlaces,
  getReviewQueueCount,
  getAutoPublishedCount,
  getConsensusStats,
  approveAndPublishPlace,
  rejectAndDeletePlace,
  sendPlaceBackToSwarm,
  getPlaceById,
  getPlaceChunks,
} from "../services/swarmTriageQueries";
import { env } from "../config";

const actionSchema = z.object({ action: z.enum(["approve", "reject", "retry"]) });

export function registerSwarmTriageRoutes(
  r: Router,
  auth: (req: Request, res: Response, next: () => void) => void,
): void {
  r.get("/api/admin/swarm-stats", auth, (_req: Request, res: Response) => {
    if (env.NODE_ROLE !== "master") {
      res.status(400).json({ success: false, message: "Not a Master." });
      return;
    }
    try {
      const s = getConsensusStats();
      res.json({ success: true, data: { ...s, timestamp: new Date().toISOString() } });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  r.get("/api/admin/auto-published", auth, (req: Request, res: Response) => {
    if (env.NODE_ROLE !== "master") {
      res.status(400).json({ success: false, message: "Not a Master." });
      return;
    }
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 500);
      const offset = Number(req.query.offset) || 0;
      res.json({
        success: true,
        data: {
          places: getAutoPublishedPlaces(limit, offset),
          total: getAutoPublishedCount(),
          limit,
          offset,
          has_more: offset + limit < getAutoPublishedCount(),
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  r.get("/api/admin/review-queue", auth, (req: Request, res: Response) => {
    if (env.NODE_ROLE !== "master") {
      res.status(400).json({ success: false, message: "Not a Master." });
      return;
    }
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 500);
      const offset = Number(req.query.offset) || 0;
      res.json({
        success: true,
        data: {
          places: getReviewQueuePlaces(limit, offset),
          total: getReviewQueueCount(),
          limit,
          offset,
          has_more: offset + limit < getReviewQueueCount(),
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  r.get("/api/admin/review-count", auth, (_req: Request, res: Response) => {
    if (env.NODE_ROLE !== "master") {
      res.status(400).json({ success: false, message: "Not a Master." });
      return;
    }
    try {
      res.json({ success: true, count: getReviewQueueCount() });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  r.get("/api/admin/review-queue/:id", auth, (req: Request, res: Response) => {
    if (env.NODE_ROLE !== "master") {
      res.status(400).json({ success: false, message: "Not a Master." });
      return;
    }
    try {
      const id = typeof req.params.id === "string" ? req.params.id : String(req.params.id);
      const place = getPlaceById(id);
      if (!place) {
        res.status(404).json({ success: false, message: "Not found." });
        return;
      }
      res.json({
        success: true,
        data: { place, chunks: getPlaceChunks(id) },
      });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  r.put("/api/admin/review-queue/:id", auth, (req: Request, res: Response) => {
    if (env.NODE_ROLE !== "master") {
      res.status(400).json({ success: false, message: "Not a Master." });
      return;
    }
    try {
      const id = typeof req.params.id === "string" ? req.params.id : String(req.params.id);
      const parsed = actionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid action." });
        return;
      }

      const place = getPlaceById(id);
      if (!place) {
        res.status(404).json({ success: false, message: "Not found." });
        return;
      }

      let ok = false;
      const { action } = parsed.data;

      if (action === "approve") ok = approveAndPublishPlace(id);
      else if (action === "reject") ok = rejectAndDeletePlace(id);
      else if (action === "retry") ok = sendPlaceBackToSwarm(id);

      const message = ok
        ? action === "approve"
          ? "approved"
          : action === "reject"
            ? "rejected"
            : "retrying"
        : "Failed";
      res.json({ success: ok, message, id, action });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });
}
