import {Request, Response, Router} from 'express';
import {WebApiSetup} from '@event-driven-io/emmett-expressjs';
// Assumption: requireUser, readmodel and the supabase api client are shared application modules
// imported from their conventional locations; this repository does not contain them yet, so these
// imports resolve once the application skeleton lands.
import {requireUser} from '../../../supabase/requireUser';
import {readmodel} from '../../../core/readmodel';
import createClient from '../../../supabase/api';
import {InvoicesReadModel, tableName} from './InvoicesProjection';

/** Raw row shape in the 'invoices' table (snake_case columns). */
type InvoicesRow = {
    invoice_id: string;
    client_name: string;
    date: string | Date;
    amount: string | number;
    status: string;
};

const toReadModel = (row: InvoicesRow): InvoicesReadModel => ({
    invoiceId: row.invoice_id,
    clientName: row.client_name,
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date),
    amount: typeof row.amount === 'string' ? Number(row.amount) : row.amount,
    status: row.status,
});

export const api = (): WebApiSetup => (router: Router): void => {

    /**
     * @openapi
     * /api/query/invoices-collection:
     *   get:
     *     tags: [Invoicing]
     *     summary: Invoices
     *     description: The Invoices read model - every invoice materialized from InvoiceCreated
     *       events, listed newest first. clientName is resolved from ClientCreated by clientId;
     *       InvoiceCreated carries no status, so every row is created with status 'Created'.
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: query
     *         name: _id
     *         required: false
     *         schema:
     *           type: string
     *         description: When set, returns the single invoice with this id instead of the full collection
     *     responses:
     *       '200':
     *         description: The Invoices read model
     *         content:
     *           application/json:
     *             schema:
     *               oneOf:
     *                 - $ref: '#/components/schemas/InvoicesReadModel'
     *                 - type: array
     *                   items:
     *                     $ref: '#/components/schemas/InvoicesReadModel'
     *       '401':
     *         description: Not authenticated
     *       '500':
     *         description: Server error
     * components:
     *   schemas:
     *     InvoicesReadModel:
     *       type: object
     *       required:
     *         - invoiceId
     *         - clientName
     *         - date
     *         - amount
     *         - status
     *       properties:
     *         invoiceId:
     *           type: string
     *           format: uuid
     *         clientName:
     *           type: string
     *         date:
     *           type: string
     *           format: date
     *         amount:
     *           type: number
     *         status:
     *           type: string
     */
    router.get('/api/query/invoices-collection', async (req: Request, res: Response) => {
        try {
            const principal = await requireUser(req, res, true);
            if (principal.error) return;

            const id = req.query._id?.toString();
            const supabase = createClient();

            const rows: InvoicesRow | InvoicesRow[] | null =
                id
                    ? await readmodel(tableName, supabase).findById<InvoicesRow>('invoice_id', id)
                    : await readmodel(tableName, supabase).findAll<InvoicesRow>({});

            const data: InvoicesReadModel | InvoicesReadModel[] =
                Array.isArray(rows)
                    // Spec: "List all invoices newest first" - sort by date descending.
                    ? rows.map(toReadModel).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
                    : rows
                        ? toReadModel(rows)
                        : [];

            const sanitized = JSON.parse(
                JSON.stringify(data, (_, value) =>
                    typeof value === 'bigint' ? value.toString() : value,
                ),
            );

            return res.status(200).json(sanitized);
        } catch (err) {
            console.error(err);
            return res.status(500).json({ok: false, error: 'Server error'});
        }
    });
};
