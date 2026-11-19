import type {Event} from '@event-driven-io/emmett';

type CommonMeta = {
    correlation_id?: string;
    causation_id?: string;
    userId?: string;
};

export type ClientCreated = Event<'ClientCreated', {
    clientId: string;
    name: string;
    contactEmail: string;
    phone?: string;
}, CommonMeta>;

export type InvoicingEvents =
    | ClientCreated;
