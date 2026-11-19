import {Request, Response, Router} from 'express';
import {WebApiSetup} from '@event-driven-io/emmett-expressjs';
import {requireUser} from '../../../supabase/requireUser';
import {CreateInvoiceCommand, handleCreateInvoice} from './CreateInvoiceCommand';

export const errorMapping = (code: string): string | null => {
    switch (code) {
        case 'client_does_not_exist':
            return 'Client does not exist';
        case 'zero_amount':
            return 'Amount must be greater than zero';
        case 'already_created':
            return 'Invoice already exists';
        default:
            return null;
    }
};

export const api = (): WebApiSetup => (router: Router): void => {
    /**
     * @openapi
     * /api/createinvoice/{invoiceId}:
     *   post:
     *     tags: [Invoicing]
     *     summary: CreateInvoice
     *     description: Create an invoice
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: path
     *         name: invoiceId
     *         required: true
     *         schema:
     *           type: string
     *           format: uuid
     *         description: Stream id this command is applied to
     *       - in: header
     *         name: correlation_id
     *         required: false
     *         schema:
     *           type: string
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required:
     *               - clientId
     *               - amount
     *               - date
     *             properties:
     *               clientId:
     *                 type: string
     *                 format: uuid
     *               amount:
     *                 type: number
     *               date:
     *                 type: string
     *                 format: date
     *     responses:
     *       '201':
     *         description: Accepted — InvoiceCreated appended
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                 next_expected_stream_version:
     *                   type: string
     *                 last_event_global_position:
     *                   type: string
     *       '401':
     *         description: Not authenticated
     *       '409':
     *         description: Client does not exist / Amount must be greater than zero / Invoice already exists
     *       '500':
     *         description: Server error
     */
    router.post('/api/createinvoice/:invoiceId', async (req: Request, res: Response) => {
        const auth = await requireUser(req, res);
        if (auth.error) return;

        const invoiceId = req.params.invoiceId;
        const correlationId = req.header('correlation_id') ?? req.header('x-correlation-id') ?? invoiceId;
        const causationId = req.header('causation_id') ?? req.header('x-causation-id') ?? invoiceId;

        try {
            const command: CreateInvoiceCommand = {
                type: 'CreateInvoice',
                data: {
                    invoiceId,
                    clientId: req.body.clientId,
                    amount: req.body.amount,
                    date: req.body.date,
                },
                metadata: {
                    correlation_id: correlationId,
                    causation_id: causationId,
                },
            };

            const result = await handleCreateInvoice(invoiceId, command);

            res.set('correlation_id', correlationId);
            res.set('causation_id', causationId);

            return res.status(201).json({
                ok: true,
                next_expected_stream_version: result.nextExpectedStreamVersion?.toString(),
                last_event_global_position: result.lastEventGlobalPosition?.toString(),
            });
        } catch (err: any) {
            const errorMessage = errorMapping(err?.code);
            if (errorMessage) {
                return res.status(409).json({error: errorMessage});
            }
            console.error(err);
            return res.status(500).json({ok: false, error: 'Server error'});
        }
    });
};
