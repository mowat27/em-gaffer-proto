import {Request, Response, Router} from 'express';
import {WebApiSetup} from '@event-driven-io/emmett-expressjs';
import {requireUser} from '../../../supabase/requireUser';
import {CreateInvoiceCommand, handleCreateInvoice} from './CreateInvoiceCommand';

export const api = (): WebApiSetup => (router: Router): void => {

    /**
     * @openapi
     * /api/createinvoice/{id}:
     *   post:
     *     tags: [Invoicing]
     *     summary: CreateInvoice
     *     description: Creates an invoice for an existing client. Rejected when the client does not exist or when the amount is not greater than zero.
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *           format: uuid
     *         description: Invoice id (generated) used as the stream id this command is applied to
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
     *             required: [clientId, amount, date]
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
     *         description: Client does not exist / Amount must be greater than zero
     *       '500':
     *         description: Server error
     */
    router.post('/api/createinvoice/:id', async (req: Request, res: Response) => {
        const auth = await requireUser(req, res);
        if (auth.error) return;

        const id = req.params.id;
        const correlationId = req.header('correlation_id') ?? id;

        try {
            const command: CreateInvoiceCommand = {
                type: 'CreateInvoice',
                data: {
                    // invoiceId is generated, so it comes from the path id.
                    invoiceId: id,
                    clientId: req.body.clientId,
                    amount: req.body.amount,
                    date: req.body.date,
                },
                metadata: {
                    correlation_id: correlationId,
                    causation_id: id,
                },
            };

            const result = await handleCreateInvoice(id, command);

            res.set('correlation_id', correlationId);
            res.set('causation_id', id);

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

const errorMapping = (code: string): string | null => {
    switch (code) {
        case 'unknown_client': return 'Client does not exist';
        case 'zero_amount': return 'Amount must be greater than zero';
        default: return null;
    }
};
