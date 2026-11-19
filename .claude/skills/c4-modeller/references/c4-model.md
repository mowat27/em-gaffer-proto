# C4 Model Reference

The C4 vocabulary this skill uses. Level names keep their official meaning (c4model.com) so that "at the C4 container level" means the same thing to every agent and person. Never invent levels, never stretch a level to cover something else.

## Abstractions

| Abstraction | Official meaning | Is | Is not |
|-------------|------------------|----|--------|
| **Person** | An actor, role, persona or named individual who uses the software systems | Customer, Administrator, Support Agent | A team that builds the system (unless they also use it) |
| **Software system** | The highest level of abstraction; something that delivers value to its users, human or not. Typically what a single team builds, owns and can see inside | Your product, a third-party SaaS API, the bank's mainframe | Product domains, bounded contexts, business capabilities, feature teams, tribes, squads |
| **Container** | An application or a data store; something that must be running for the software system to work. A runtime boundary around executing code or stored data | Server-side web app, SPA in a browser, desktop app, mobile app, console app or batch job, serverless function, database schema, blob store bucket, file system folder, shell script, a single queue or topic | A Docker container (the name is unrelated), a JAR, DLL, module, package or library, a message broker as a whole |
| **Component** | A grouping of related functionality behind a well-defined interface, inside one container. Not separately deployable; all components of a container share its process space | A controller, a service with its repository, a facade, an adapter, a JavaScript module | A class (that is code), a package/namespace/folder (organisational, though it may map 1:1), a separately running process |
| **Code** | The classes, interfaces, functions, objects and tables that implement a component | Classes, functions, database tables | Anything modelled in Structurizr DSL; the DSL has no code level |

Hierarchy: a software system is made of containers; a container is made of components; a component is implemented by code.

## Classification Rules

Apply these when deciding what a thing is. Ownership and runtime boundaries decide, not technology.

- **Software system vs container**: if the team building the system in scope owns it and can see inside it, it is a container of that system. If another team or company owns it, it is a separate software system.
- **Microservices**: one team owning many services → each service is a group of containers (an API container plus its database schema container) inside one software system; use a `group` to pair them. Services owned by separate teams → each service is its own software system.
- **Server-rendered web app**: one container. A server app that ships a substantial JavaScript SPA → two containers (server app and SPA), because they are separate process spaces talking over HTTP.
- **Managed data services** (S3, RDS, Azure SQL, Supabase Postgres, a CDN): containers, because you own the bucket or schema even though someone else hosts it.
- **Third-party APIs you only call** (Stripe, an LLM provider, an e-mail service): external software systems, shown as black boxes. Never model their internals.
- **Message brokers**: never one container for "Kafka" or "RabbitMQ". Each queue or topic is a container (it is a data store), or, when coupling is genuinely point-to-point, omit the queue and put its name on the relationship ("Sends order events to [via orders.created]").
- **Shared libraries, SDKs, packages**: not containers. They are code copied into containers. Omit them, or show the functionality they provide as components inside each container that uses them.
- **Serverless functions**: each function (or function app deployed as one unit) is a container.
- **Infrastructure** (load balancers, reverse proxies, API gateways run as infrastructure, DNS and custom domains, firewalls, schedulers and cron triggers, OTel collectors, dev servers): not containers. They belong in deployment models as infrastructure nodes.
- **Static file hosting**: an SPA is its own container wherever its files are served from. When a server container also serves the SPA's files, model `server -> spa "Delivers the web application's static files to"`; when a CDN or bucket serves them, that bucket is a `File Store` container or the CDN is infrastructure in the deployment model.
- **Docker / Kubernetes**: deployment concerns. A Docker container hosting an app is a deployment node running a container instance.
- **Subsystems, layers, bounded contexts, modules**: not abstraction levels. If grouping helps, use a `group` of elements at one level. Never add "level 2.5" or "sub-components".
- **AI agents**: an agent process, worker or runtime is a container; its tools, prompt assembly, planner and memory are components; a hosted model API (Anthropic, OpenAI, OpenRouter) is an external software system; a vector index you own is a container.

## Diagram Types (Views)

| View | Scope | Primary elements | Supporting elements | Audience | Recommended |
|------|-------|------------------|---------------------|----------|-------------|
| System landscape | An enterprise, organisation or department | People and software systems | — | Everyone | Yes, for portfolios of systems |
| System context | One software system | The system in scope | People and software systems directly connected to it | Everyone, technical or not | Yes, always |
| Container | One software system | Containers in that system | People and software systems directly connected to the containers | Technical people: architects, developers, operations | Yes, always |
| Component | One container | Components in that container | Containers of the same system, people and software systems directly connected to the components | Architects and developers | Only when it adds value |
| Code | One component | Classes, functions, tables | — | Architects and developers | No; IDEs generate it on demand |
| Dynamic | One feature, story or use case | Your choice of systems, containers or components | — | Everyone | Sparingly, for interesting or recurring flows |
| Deployment | One or more systems in one environment | Deployment nodes, software system and container instances | Infrastructure nodes | Technical people including infrastructure and operations | Yes |

Context plus container is enough for most teams. Model component level only for containers where it earns its place.

## Scoping by Level

Use this table to scope any question, answer or model fragment to a named level. "At the C4 X level" fixes **which elements to consider** and **how much detail to give**.

| Level | Elements in play | Give | Leave out |
|-------|------------------|------|-----------|
| **System landscape** | People and software systems across the organisation | Which systems exist, who uses them, which systems exchange what business information | Containers, technologies, protocols, anything inside a system |
| **System context** | The system in scope, its users, the external systems it talks to | Purpose, users, the business information flowing in and out, in plain language | Containers, technologies, protocols, data formats, internals of any system |
| **Container** | Containers inside the system in scope, plus directly connected people and external systems | Each container's responsibility and technology; what high-level domain data flows between them ("order details", "rendered PDF", "user session"); the protocol on each inter-process relationship ("JSON/HTTPS", "SQL", "SQS") | Classes, functions, endpoints lists, JSON payloads, field-level schemas, config flags, clustering, replicas, hosting topology |
| **Component** | Components inside one container, plus the containers, people and systems they connect to | Each component's responsibility, its interface at the level of named operations, dependencies between components, framework or technology | Class lists, method signatures, field-level schemas, private helpers, every utility |
| **Code** | Code elements inside one component | Classes, functions, signatures, fields, tables, as needed for the story | Anything outside the component |
| **Deployment** | Deployment nodes, infrastructure nodes, container and system instances in one environment | Where each container runs, node technology, instance counts, infrastructure in the path | Component internals, business logic |
| **Dynamic** | The elements (at one chosen level) that take part in one flow | Ordered steps, each a relationship that exists in the static model | Steps at a different level from the one chosen |

Example of the difference. "What are the inputs to the rendering engine?" invites a tour of the whole API. "What are the inputs to the rendering engine at the C4 container level?" means: treat the rendering engine as a container; list the people, containers and external systems that supply data to it; for each, name the domain data it supplies and the protocol. Report "report definitions from the Web App over JSON/HTTPS", not the JSON schema of a report definition.

Direction in questions: "inputs", "outputs", "receives" and "sends" follow **data flow**, whichever side initiates the call (a database the subject reads from is an input). "Depends on", "calls" and "uses" follow **dependency**, the initiator's direction.

## Notation Rules as Data

C4 is notation-independent, but the model must carry everything a reader needs. Every model built by this skill satisfies these rules in the data itself:

- Every element has an explicit type (person, software system, container, component, deployment node, infrastructure node).
- Every element has a short description of its key responsibility.
- Every container, component, deployment node and infrastructure node has a technology.
- Every relationship is unidirectional and has a description that matches its direction. Use a specific verb phrase ("Reads orders from", "Sends password-reset e-mails using"), never a bare "Uses" between software parts.
- Relationships between containers (inter-process) carry a technology or protocol.
- Lines represent either dependency or data flow; choose one per model and keep descriptions consistent with arrow direction.
- Names are consistent across levels: the same thing has the same name everywhere.
- Acronyms in names and descriptions are either common to all readers or spelled out in the description.
- Diagrams show outcomes, not decision processes. Options and rationale belong in ADRs, not in the model.

## Anti-Patterns

| Anti-pattern | Fix |
|--------------|-----|
| A class or module modelled as a container | Make it a component inside the container that runs it |
| An invented level ("subsystem", "sub-component", "level 2.5") | Map it to the nearest real level; use a `group` for organisational grouping |
| A shared library as a container | Remove it, or show its functionality as components in each container using it |
| A message broker as one hub container | Model each queue or topic as a container, or name it on the relationship |
| Internals of an external system | Keep the external system as one black-box software system |
| An element with no description or no technology | Add both; the inspections flag them |
| Generic relationship labels ("Uses", "Calls", "Data") between software parts | Say what flows and why ("Fetches account balances from") |
| Bidirectional relationships | Two unidirectional relationships, each labelled from its source's perspective |
| Infrastructure (load balancer, Kubernetes, VPC) in the container model | Move it to a deployment environment |
| Deployment model with no named environment | Name the environment (Live, Staging, Development) |
| Component level for every container by default | Model components only where asked or where the container is complex enough to need it |
| More than 20 elements in one view | Split into several views by group, by container, or by one element and its direct couplings |
| The same thing named differently at different levels | One element, one name |

## Audience Guide

| Audience | Levels |
|----------|--------|
| Executives, non-technical stakeholders | System landscape, system context |
| Product managers | System context, container |
| Architects | System context, container, key components |
| Developers | Any level as needed, including code |
| Operations, infrastructure | Container, deployment |
