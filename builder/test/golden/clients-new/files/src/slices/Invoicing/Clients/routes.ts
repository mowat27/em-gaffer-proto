import {Request, Response, Router} from 'express';
import {WebApiSetup} from '@event-driven-io/emmett-expressjs';
import {requireUser} from '../../../supabase/requireUser';
import {getKnexInstance} from '../../../common/db';
import {type ClientsReadModel, readModelColumns, tableName} from './ClientsProjection';

export const api = (): WebApiSetup => (router: Router): void => {

    /**
     * @openapi
     * /api/query/clients-collection:
     *   get:
     *     tags: [Invoicing]
     *     summary: Clients
     *     description: The Clients read model
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: query
     *         name: _id
     *         required: false
     *         schema:
     *           type: string
     *         description: When set, returns the row with this clientId instead of the full collection
     *     responses:
     *       '200':
     *         description: The Clients read model
     *         content:
     *           application/json:
     *             schema:
     *               oneOf:
     *                 - $ref: '#/components/schemas/ClientsReadModel'
     *                 - type: array
     *                   items:
     *                     $ref: '#/components/schemas/ClientsReadModel'
     *       '401':
     *         description: Not authenticated
     *       '500':
     *         description: Server error
     * components:
     *   schemas:
     *     ClientsReadModel:
     *       type: object
     *       properties:
     *         clientId:
     *           type: string
     *           format: uuid
     *         name:
     *           type: string
     *         contactEmail:
     *           type: string
     */
    router.get('/api/query/clients-collection', async (req: Request, res: Response) => {
        try {
            const principal = await requireUser(req, res, true);
            if (principal.error) return;

            const db = getKnexInstance();
            const query = db(tableName).withSchema('public').select(readModelColumns(db));
            const id = req.query._id?.toString();
            const data: ClientsReadModel | ClientsReadModel[] | null = id
                ? ((await query.where('client_id', id).first()) ?? null)
                : await query;

            return res.status(200).json(data);
        } catch (err) {
            console.error(err);
            return res.status(500).json({ok: false, error: 'Server error'});
        }
    });
};
