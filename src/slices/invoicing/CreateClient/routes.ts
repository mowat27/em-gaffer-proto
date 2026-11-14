import {Request, Response, Router} from 'express';
import {WebApiSetup} from '@event-driven-io/emmett-expressjs';
import {requireUser} from '../../../supabase/requireUser';
import {CreateClientCommand, handleCreateClient} from './CreateClientCommand';

export const api = (): WebApiSetup => (router: Router): void => {

    /**
     * @openapi
     * /api/createclient/{id}:
     *   post:
     *     tags: [Invoicing]
     *     summary: CreateClient
     *     description: Creates a client. Client name is required (rejected when blank after trimming); contact email must be a valid email address. By board decision there is no create-once guard: a repeated POST on the same clientId appends another ClientCreated.
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *           format: uuid
     *         description: Client id (generated) used as the stream id this command is applied to
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
     *             required: [name, contactEmail]
     *             properties:
     *               name:
     *                 type: string
     *                 example: Great GlenLtd
     *               contactEmail:
     *                 type: string
     *     responses:
     *       '201':
     *         description: Accepted — ClientCreated appended
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
     *         description: Client name is required / Contact email must be a valid email address
     *       '500':
     *         description: Server error
     */
    router.post('/api/createclient/:id', async (req: Request, res: Response) => {
        const auth = await requireUser(req, res);
        if (auth.error) return;

        const id = req.params.id;
        const correlationId = req.header('correlation_id') ?? id;

        try {
            const command: CreateClientCommand = {
                type: 'CreateClient',
                data: {
                    clientId: id,
                    name: req.body.name,
                    contactEmail: req.body.contactEmail,
                },
                metadata: {
                    correlation_id: correlationId,
                    causation_id: id,
                },
            };

            const result = await handleCreateClient(id, command);

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
        case 'empty_name': return 'Client name is required';
        case 'invalid_contact_email': return 'Contact email must be a valid email address';
        default: return null;
    }
};
