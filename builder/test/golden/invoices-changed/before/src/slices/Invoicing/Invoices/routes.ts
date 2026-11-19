import {Request, Response, Router} from 'express';
import {WebApiSetup} from '@event-driven-io/emmett-expressjs';
import {requireUser} from '../../../supabase/requireUser';
import {getKnexInstance} from '../../../common/db';
import {type InvoicesReadModel, readModelColumns, tableName} from './InvoicesProjection';

export const api = (): WebApiSetup => (router: Router): void => {

    /**
     * @openapi
     * /api/query/invoices-collection:
     *   get:
     *     tags: [Invoicing]
     *     summary: Invoices
     *     description: The Invoices read model
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: query
     *         name: _id
     *         required: false
     *         schema:
     *           type: string
     *         description: When set, returns the row with this invoiceId instead of the full collection
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

            const db = getKnexInstance();
            const query = db(tableName).withSchema('public').select(readModelColumns(db));
            const id = req.query._id?.toString();
            const data: InvoicesReadModel | InvoicesReadModel[] | null = id
                ? ((await query.where('invoice_id', id).first()) ?? null)
                : await query;

            return res.status(200).json(data);
        } catch (err) {
            console.error(err);
            return res.status(500).json({ok: false, error: 'Server error'});
        }
    });
};
