import {Request, Response, Router} from 'express';
import {WebApiSetup} from '@event-driven-io/emmett-expressjs';
// Assumption: requireUser, readmodel and the supabase api client are shared application modules
// imported from their conventional locations; this repository does not contain them yet, so these
// imports resolve once the application skeleton lands.
import {requireUser} from '../../../supabase/requireUser';
import {readmodel} from '../../../core/readmodel';
import createClient from '../../../supabase/api';
import {ClientsReadModel, tableName} from './ClientsProjection';

/** Raw row shape in the 'clients' table (snake_case columns). */
type ClientsRow = {
    client_id: string;
    name: string;
    contact_email: string;
};

const toReadModel = (row: ClientsRow): ClientsReadModel => ({
    clientId: row.client_id,
    name: row.name,
    contactEmail: row.contact_email,
});

export const api = (): WebApiSetup => (router: Router): void => {

    /**
     * @openapi
     * /api/query/clients-collection:
     *   get:
     *     tags: [Invoicing]
     *     summary: Clients
     *     description: The Clients read model - every client materialized from ClientCreated events.
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: query
     *         name: _id
     *         required: false
     *         schema:
     *           type: string
     *         description: When set, returns the single client with this id instead of the full collection
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
     *       required:
     *         - clientId
     *         - name
     *         - contactEmail
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

            const id = req.query._id?.toString();
            const supabase = createClient();

            const rows: ClientsRow | ClientsRow[] | null =
                id
                    ? await readmodel(tableName, supabase).findById<ClientsRow>('client_id', id)
                    : await readmodel(tableName, supabase).findAll<ClientsRow>({});

            const data: ClientsReadModel | ClientsReadModel[] =
                Array.isArray(rows)
                    ? rows.map(toReadModel)
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
