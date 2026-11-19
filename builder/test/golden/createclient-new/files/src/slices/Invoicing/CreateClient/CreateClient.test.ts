import {DeciderSpecification} from '@event-driven-io/emmett';
import {describe, it} from 'node:test';
import {
    type CreateClientCommand,
    CreateClientInitialState,
    decide,
    evolve,
} from './CreateClientCommand';

const rejectedWith = (code: string) => (error: Error) => (error as Error & {code?: string}).code === code;

describe('CreateClient Specification', () => {
    const given = DeciderSpecification.for({
        decide,
        evolve,
        initialState: CreateClientInitialState,
    });

    it('spec: Create a client', () => {
        // BUILD: test data. The specification gives no example for contactEmail: replace the placeholders with values that fit it.
        const command: CreateClientCommand = {
            type: 'CreateClient',
            data: {
                clientId: '00000000-0000-4000-8000-000000000001',
                name: 'Great GlenLtd',
                contactEmail: '<contactEmail>',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .then([
                {
                    type: 'ClientCreated',
                    data: {
                        clientId: '00000000-0000-4000-8000-000000000001',
                        name: 'Great GlenLtd',
                        contactEmail: '<contactEmail>',
                    },
                    metadata: {},
                },
            ]);
    });

    it('spec: Empty name is rejected', () => {
        // BUILD: test data. Give the command values that break only "Empty name is rejected" (Client name is required).
        const command: CreateClientCommand = {
            type: 'CreateClient',
            data: {
                clientId: '00000000-0000-4000-8000-000000000001',
                name: 'Great GlenLtd',
                contactEmail: '<contactEmail>',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .thenThrows(rejectedWith('empty_name_is_rejected'));
    });

    it('spec: Invalid contact email is rejected', () => {
        // BUILD: test data. Give the command values that break only "Invalid contact email is rejected" (Contact email must be a valid email address).
        const command: CreateClientCommand = {
            type: 'CreateClient',
            data: {
                clientId: '00000000-0000-4000-8000-000000000001',
                name: 'Great GlenLtd',
                contactEmail: '<contactEmail>',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .thenThrows(rejectedWith('invalid_contact_email_is_rejected'));
    });
});
