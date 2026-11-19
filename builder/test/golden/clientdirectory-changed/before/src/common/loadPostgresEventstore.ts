import {getPostgreSQLEventStore} from "@event-driven-io/emmett-postgresql";
import {projections} from "@event-driven-io/emmett";
import {postgresUrl, getSharedPool} from "./db";
import {ClientDirectoryProjection} from "../slices/Reporting/ClientDirectory/ClientDirectoryProjection";

let eventStoreInstance: ReturnType<typeof getPostgreSQLEventStore> | null = null;

export const findEventstore = async () => {
    if (!eventStoreInstance) {
        eventStoreInstance = getPostgreSQLEventStore(postgresUrl, {
            schema: {
                autoMigration: "CreateOrUpdate"
            },
            connectionOptions: {
                pooled: true,
                pool: getSharedPool(),
            },
            projections: projections.inline([
                ClientDirectoryProjection,
            ]),
        });
        await eventStoreInstance.schema.migrate();
    }
    return eventStoreInstance;
};
