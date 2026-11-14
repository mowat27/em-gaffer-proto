import {getPostgreSQLEventStore} from '@event-driven-io/emmett-postgresql';
import {projections} from '@event-driven-io/emmett';
import {ClientsProjection} from '../slices/invoicing/Clients/ClientsProjection';

// Event store loader: registers every slice projection with the PostgreSQL event store so events
// flowing through the store are projected inline. New slices add their projection to the
// projections.inline([...]) list below.
export const loadPostgresEventstore = (connectionString: string) =>
    getPostgreSQLEventStore(connectionString, {
        projections: projections.inline([
            ClientsProjection,
        ]),
    });

export default loadPostgresEventstore;
