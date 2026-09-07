import { Router, Request, Response, NextFunction } from 'express';
import { attackLimiter } from './middleware/rateLimiter';
import { requireAttackToken } from '../modules/attacks/auth';
import { listCatalog, getScenario } from '../modules/attacks/catalog';
import { launchScenario, launchLegitPayment } from '../modules/attacks/engine';
import { listTargetUsers, getLiveTransactions } from '../modules/attacks/demoData';
import { getRun, getEvents, listRuns } from '../modules/attacks/runStore';

const router = Router();
router.use(attackLimiter);
router.use(requireAttackToken);

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

router.get('/scenarios', (_req, res) => {
  res.json(listCatalog());
});

router.get('/scenarios/:id', (req, res) => {
  const scenario = getScenario(req.params.id);
  if (!scenario) {
    res.status(404).json({ failureCode: 'NOT_FOUND', message: 'Unknown scenario.' });
    return;
  }
  res.json(scenario);
});

router.get(
  '/targets',
  wrap(async (_req, res) => {
    res.json(await listTargetUsers());
  })
);

/**
 * The Live Attack Lab's discovery feed — real, currently-observable
 * transactions read straight off the `transactions` table (see
 * demoData.getLiveTransactions). A transaction a real browser created via
 * the ordinary Pay flow and one the Lab's own "run legitimate transaction"
 * helper created are indistinguishable here; nothing is synthesized.
 * Polled by the frontend at ~1s — stays behind the same attackLimiter/
 * requireAttackToken gate as every other route in this router.
 */
router.get(
  '/live-transactions',
  wrap(async (_req, res) => {
    res.json(await getLiveTransactions());
  })
);

router.post(
  '/scenarios/:id/launch',
  wrap(async (req, res) => {
    const scenario = getScenario(req.params.id);
    if (!scenario) {
      res.status(404).json({ failureCode: 'NOT_FOUND', message: 'Unknown scenario.' });
      return;
    }
    const transactionId = req.body.transactionId ? String(req.body.transactionId) : undefined;
    const targetUserId = req.body.targetUserId ? String(req.body.targetUserId) : undefined;
    const attackerLabel = String(req.body.attackerLabel ?? 'Attacker Device');
    if (!transactionId && !targetUserId) {
      res.status(400).json({
        failureCode: 'INVALID_AMOUNT',
        message: 'Either transactionId (a live transaction) or targetUserId (self-contained fallback) is required.',
      });
      return;
    }
    const runId = await launchScenario(
      scenario.id,
      {
        transactionId,
        targetUserId,
        victimSessionCookie: req.body.victimSessionCookie ? String(req.body.victimSessionCookie) : undefined,
        attackerSessionCookie: req.body.attackerSessionCookie ? String(req.body.attackerSessionCookie) : undefined,
      },
      attackerLabel
    );
    res.status(202).json({ runId });
  })
);

router.post(
  '/legit-payment/launch',
  wrap(async (req, res) => {
    const targetUserId = String(req.body.targetUserId ?? '');
    const attackerLabel = String(req.body.deviceLabel ?? 'Legitimate Device');
    if (!targetUserId) {
      res.status(400).json({ failureCode: 'INVALID_AMOUNT', message: 'targetUserId is required.' });
      return;
    }
    const runId = await launchLegitPayment(targetUserId, attackerLabel, {
      amountMinor: req.body.amountMinor ? Number(req.body.amountMinor) : undefined,
      useNeverPaidPayee: Boolean(req.body.useNeverPaidPayee),
    });
    res.status(202).json({ runId });
  })
);

router.get(
  '/runs',
  wrap(async (_req, res) => {
    res.json(await listRuns());
  })
);

router.get(
  '/runs/:id',
  wrap(async (req, res) => {
    const run = await getRun(req.params.id);
    if (!run) {
      res.status(404).json({ failureCode: 'NOT_FOUND', message: 'No such run.' });
      return;
    }
    const events = await getEvents(req.params.id);
    res.json({ run, events });
  })
);

export default router;
