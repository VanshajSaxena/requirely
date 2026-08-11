# Requirely

## The Problem

AI can write code faster than humans can **specify, gather, and document requirements**.

As AI makes software development increasingly faster, coding is no longer the primary bottleneck. **Humans are.**

The bottleneck has shifted from:

> “How fast can we build?”

to:

> “How quickly can we understand what actually needs to be built?”

Before AI can build a product effectively, someone still needs to communicate the product vision, requirements, constraints, edge cases, and expected behavior clearly.

That process is often slow, fragmented, and incomplete.

---

# Requirely's Solution

**Requirely turns raw expectations, requirements, conversations, context, and product vision into a structured understanding of what needs to be built.**

The user can provide information in whatever form is most natural or useful to them.

Requirely can ingest:

- Voice recordings
- Meeting recordings
- Voice notes
- Spoken product ideas
- Text
- Documents
- Existing requirements
- Code
- Product context
- Conversations
- Other relevant project information

The user does not need to structure their thoughts beforehand.

They can simply start dumping everything they know about the product into Requirely.

Requirely analyzes the information, identifies what the user is trying to build, detects gaps and ambiguities, asks targeted questions, and continuously refines its understanding until it has enough information.

The final output can then be whatever the user needs, such as:

- **Software Requirements Specification (SRS)**
- **Requirements / Product Document**
- **AI Prompt** ready to be given to an AI coding agent

The user can specify the desired output **before starting the requirement-gathering process** — for example:

> “Write an SRS.”

Alternatively, the user can simply provide information first and **decide what they want Requirely to produce later**.

The core product is **not the document generation**.

The core product is the **requirement-gathering loop** that happens before the document is generated.

> **Requirely: Gather software requirements faster.**

---

# How It Works

## 1. Input — Give Requirely Everything You Know

Requirely is not limited to a single input format.

The user can provide any information that helps communicate what they want to build, including:

- Audio
- Voice recordings
- Meeting recordings
- Voice notes
- Text
- Documents
- Existing requirements
- Code
- Product context
- Conversations
- Other project materials

The user does not need to decide in advance how the information should be structured.

They can simply start providing context.

For example, a user might:

- Upload a document describing the business
- Paste existing requirements
- Provide some existing code
- Record a voice note explaining the product
- Add notes from a conversation with a client
- Explain additional requirements verbally

Requirely's job is to bring all of this information together and build an understanding of what needs to be built.

---

## 2. Questions — AI Finds the Gaps

Requirely analyzes the information provided and builds an understanding of what the user is trying to create.

It identifies:

- What the user is trying to build
- Core requirements
- User expectations
- Constraints
- Ambiguities
- Missing information
- Potential edge cases
- Contradictions
- Assumptions
- Areas where its understanding is incomplete

Instead of immediately generating a final output, Requirely asks the user **targeted questions** to clarify the requirements.

### Low-Effort Answers

Whenever possible, Requirely generates answer options for the user.

For example:

> **Who should be able to create an account?**
>
> A. Anyone
> B. Invited users only
> C. Admin-created accounts
> D. Other

The user can simply select an option.

This makes answering questions significantly faster than writing responses from scratch.

### High-Effort Answers

If none of the options are appropriate, the user can provide their own answer.

This gives the user both:

- **Lowest effort:** Select an option
- **Highest flexibility:** Provide a custom answer

---

# 3. Answers — User Clarifies

The user answers Requirely's questions by:

- Selecting one or more generated options
- Providing a custom answer
- Adding additional context when necessary

Each answer gives Requirely more information about the product and reduces uncertainty.

The answers become part of Requirely's evolving understanding of the requirements.

---

# 4. Thinking — The Requirement-Gathering Loop

After receiving the user's answers, Requirely reassesses its understanding.

It asks itself:

> **“Do I have enough information to confidently describe what needs to be built?”**

If the answer is **no**, Requirely generates another set of targeted questions.

The user answers them.

Requirely thinks again.

This loop continues until Requirely determines that it has sufficient information.

### The Loop

**Input → Understand → Identify Gaps → Ask Questions → Receive Answers → Re-evaluate → Ask More Questions if Needed → Finalize**

The goal is not to ask as many questions as possible.

The goal is to ask **only the questions necessary to reach a sufficiently complete understanding of the requirements.**

The input to this loop can come from any combination of sources — voice, text, documents, code, existing context, conversations, or other project information.

---

# 5. Output — Decide What You Want From the Understanding

Once Requirely has enough information, it generates the output requested by the user.

There are two ways the user can specify what they want.

### Before the Conversation

The user can tell Requirely what they want before providing their information.

For example:

> “Write an SRS.”

Requirely then gathers and structures the necessary requirements with that desired output in mind.

### After Providing the Information

The user can also start without specifying an output.

They can simply dump documents, context, text, code, voice recordings, conversations, and other information into Requirely.

Once Requirely has gathered and understood the requirements, the user can decide what they want out of it.

For example:

> “Now turn this into an SRS.”

or:

> “Create a prompt I can give to an AI coding agent.”

This makes Requirely useful not only as a document generator, but as a **requirement-understanding engine** that can produce different outputs from the same underlying understanding.

### Option A — SRS Document

A structured **Software Requirements Specification** containing the relevant requirements, behaviors, constraints, assumptions, and other information needed to communicate what should be built.

### Option B — Requirements Document

A more general product/requirements document suitable for sharing with:

- Developers
- Product Managers
- Clients
- Designers
- Teams
- AI coding agents

### Option C — AI Prompt

A structured prompt containing everything the AI coding agent needs to understand the product and begin building it.

The output format is ultimately a means of making Requirely's understanding useful to humans or AI systems.

---

# The Differentiator

Requirely is not trying to be another general-purpose AI assistant.

Its purpose is extremely specific:

> **Gather software requirements faster.**

It will do whatever is necessary to achieve that goal.

That means Requirely is not fundamentally defined by:

- Voice
- Documents
- Text
- Code
- SRS generation
- Prompt generation

These are mechanisms through which Requirely gathers and understands requirements.

The product should evolve based on what best enables its core objective.

> **Requirely has one goal: Gather software requirements faster.**

If ingesting code helps understand the requirements, Requirely should ingest code.

If documents contain important context, Requirely should ingest documents.

If voice is the fastest way for a user to explain an idea, Requirely should ingest voice.

If text, conversations, existing specifications, or other forms of context are useful, Requirely should support them as well.

The product name may eventually change if a different name better represents what the product actually does. For now, the product is consistently referred to as **Requirely**.

The output is not the only product.

The **requirement-gathering process itself is the product.**

---

# What Requirely Does Differently

Instead of taking an initial prompt and immediately producing an answer, Requirely is designed to first understand the user's work.

It actively tries to answer:

### What is the user trying to build?

Understand the product, its purpose, users, workflows, and desired outcome.

### What are the core requirements?

Identify the functionality and behavior that the user actually expects.

### What are the constraints?

Understand technical, business, operational, or product constraints specific to the project.

### What information already exists?

Extract useful requirements and context from whatever the user provides, including voice, text, documents, code, conversations, and existing product information.

### What is missing?

Identify gaps, ambiguities, contradictions, assumptions, and unanswered questions.

### What does the AI still need to know?

Ask focused questions until the requirements are sufficiently clear.

This creates a structured **requirement discovery and clarification loop** rather than a simple prompt-to-output interaction.

---

# Initial Product Scope

The first build will be **backend-only**.

The initial version will focus on the core intelligence and workflow:

1. Accept information from supported input sources
2. Transcribe audio when necessary
3. Process and understand voice, text, documents, code, and other context
4. Analyze requirements
5. Identify gaps and ambiguities
6. Generate clarification questions
7. Generate answer options
8. Process user answers
9. Re-evaluate the requirements
10. Continue the questioning loop when necessary
11. Determine when requirements are sufficiently complete
12. Generate the requested final output

The first version does **not** need to focus on building a polished frontend.

The priority is proving that the **requirement-gathering engine works.**

The initial implementation may prioritize voice as an important input method, but the underlying product should not be architected around voice alone. Requirely's core capability is understanding requirements from whatever relevant information the user provides.

## Constraint

The product will not be built surrounding/supporting a single AI provider, the application will define a clean interfaces and implement them for different API providers, making the AI provider switching/swapping very easy, potentially allowing multiple providers at different layers if needed.

---

# Core Product Philosophy

Requirely should make it easier for humans to communicate what they want to build.

The user shouldn't have to know how to write:

- Perfect prompts
- Technical specifications
- Structured requirements
- Detailed product documents

They should be able to provide information naturally, in whatever format is available to them.

Requirely's job is to transform that raw information into a clear, sufficiently complete understanding of the product — and ultimately into something that humans or AI can use to build it.

The fundamental objective remains simple:

> **Gather software requirements faster.**

> **Humans provide context. Requirely asks. Requirely understands. Then humans or AI build.**
