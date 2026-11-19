import type {Event} from '@event-driven-io/emmett';

type CommonMeta = {
    correlation_id?: string;
    causation_id?: string;
    userId?: string;
};

// Fields from slice.json event definitions
export type ClientCreated = Event<'ClientCreated', {
    clientId: string;
    name?: string;
}, CommonMeta>;

export type InvoiceCreated = Event<'InvoiceCreated', {
    invoiceId: string;
    clientId: string;
    amount: number;
    date: string;
}, CommonMeta>;

export type InvoicingEvents = ClientCreated | InvoiceCreated;
