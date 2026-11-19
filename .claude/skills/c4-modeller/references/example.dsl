workspace "Internet Banking" "C4 model of the internet banking system." {

    !identifiers hierarchical

    properties {
        "structurizr.inspection.model.softwaresystem.documentation" "ignore"
        "structurizr.inspection.model.softwaresystem.decisions" "ignore"
        "structurizr.inspection.model.relationship[person->softwaresystem].technology" "ignore"
        "structurizr.inspection.model.relationship[person->container].technology" "ignore"
        "structurizr.inspection.model.relationship[person->component].technology" "ignore"
        "structurizr.inspection.model.relationship[component->component].technology" "ignore"
        "structurizr.inspection.model.relationship[softwaresystem->person].technology" "ignore"
        "structurizr.inspection.model.relationship[container->person].technology" "ignore"
    }

    model {
        customer = person "Personal Banking Customer" "A customer of the bank with a personal bank account."

        banking = softwareSystem "Internet Banking System" "Lets customers view their accounts and make payments." {
            spa = container "Single-Page Application" "Provides banking functionality to customers in their browser." "TypeScript, React" "Web Browser"
            api = container "API Application" "Provides banking functionality via a JSON/HTTPS API." "Java, Spring Boot" {
                signIn = component "Sign In Controller" "Signs customers in." "Spring MVC Rest Controller"
                accounts = component "Accounts Summary Controller" "Provides a summary of a customer's accounts." "Spring MVC Rest Controller"
                security = component "Security Component" "Checks credentials and issues tokens." "Spring Bean"
                mainframeFacade = component "Mainframe Banking Facade" "Adapts the mainframe's interface for the other components." "Spring Bean"

                signIn -> security "Validates credentials using"
                accounts -> mainframeFacade "Gets account balances using"
            }
            db = container "Database" "Stores customer credentials and access logs." "PostgreSQL" "Database"
            paymentsQueue = container "payments.requested" "Holds payment requests until the mainframe processes them." "Amazon SQS" "Queue"

            spa -> api "Signs customers in and fetches account summaries using" "JSON/HTTPS"
            spa -> api.signIn "Submits sign-in details to" "JSON/HTTPS"
            spa -> api.accounts "Requests account summaries from" "JSON/HTTPS"
            api.security -> db "Reads credentials from and writes access logs to" "SQL/TCP"
            api -> paymentsQueue "Sends payment requests to" "AWS SDK/HTTPS"
        }

        mainframe = softwareSystem "Mainframe Banking System" "Stores core banking information about customers, accounts and transactions." "External"
        email = softwareSystem "E-mail System" "Sends e-mails to customers." "External"

        customer -> banking.spa "Views account balances and makes payments using"
        banking.api.mainframeFacade -> mainframe "Gets account information from" "XML/HTTPS"
        mainframe -> banking.paymentsQueue "Takes payment requests from" "AWS SDK/HTTPS"
        banking.api -> email "Sends password-reset e-mails using" "SMTP"
        email -> customer "Sends e-mails to"

        live = deploymentEnvironment "Live" {
            deploymentNode "Customer's computer" "The customer's desktop or laptop." "Windows or macOS" {
                deploymentNode "Web Browser" "Runs the single-page application." "Chrome, Firefox, Safari or Edge" {
                    containerInstance banking.spa
                }
            }
            aws = deploymentNode "Amazon Web Services" "Hosts the bank's cloud workloads." "AWS" {
                region = deploymentNode "eu-west-2" "London region." "AWS Region" {
                    lb = infrastructureNode "Load Balancer" "Spreads API traffic across instances." "Elastic Load Balancer"
                    ecs = deploymentNode "API Cluster" "Runs the API containers." "Amazon ECS Fargate" "" "2..4" {
                        apiInstance = containerInstance banking.api
                    }
                    rds = deploymentNode "Primary Database" "Managed relational database." "Amazon RDS for PostgreSQL" {
                        containerInstance banking.db
                    }
                    sqs = deploymentNode "Message Queues" "Managed queue service." "Amazon SQS" {
                        containerInstance banking.paymentsQueue
                    }
                    lb -> ecs.apiInstance "Forwards requests to" "HTTPS"
                }
            }
            deploymentNode "Bank data centre" "The bank's on-premises data centre." "Bank-owned" {
                softwareSystemInstance mainframe
            }
        }
    }

    views {
        systemLandscape "system-landscape" "Everyone and every system in the internet banking landscape." {
            include *
        }
        systemContext banking "system-context" "The Internet Banking System, its users and the systems it depends on." {
            include *
        }
        container banking "containers" "The applications and data stores inside the Internet Banking System." {
            include *
        }
        component banking.api "components-api" "The components inside the API Application." {
            include *
        }
        dynamic banking.api "dynamic-sign-in" "How a customer signs in." {
            banking.spa -> banking.api.signIn "Submits sign-in details to" "JSON/HTTPS"
            banking.api.signIn -> banking.api.security "Validates credentials using"
            banking.api.security -> banking.db "Reads credentials from" "SQL/TCP"
        }
        deployment banking live "deployment-live" "How the Internet Banking System is deployed in the live environment." {
            include *
        }
    }

    configuration {
        scope softwaresystem
    }
}
