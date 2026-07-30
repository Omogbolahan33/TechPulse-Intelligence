# Core Architectural Directives

When building, upgrading, or modifying architecture, you MUST ALWAYS follow this rule:
1. **You must USE THE BEST AND SCALABLE METHOD.**
2. **Maintain backward compatibility to avoid breakage.** E.g., when upgrading data structures, support both the legacy layout and the new scalable schematic in the UI rendering layer components so as not to crash the application on existing/cached data.
3. **The 2-Way Proposal/Counterproposal Refinement:** ALWAYS critically analyze user requests for scalability traps or architectural flaws before blindly implementing them. If a user requests a feature that breaks caching, spikes API costs, or creates technical debt, you MUST aggressively push back. Propose the "elite" alternate architecture that solves their underlying goal efficiently, cost-effectively, and scalably (e.g., Asymmetric Routing instead of Just-In-Time Generation). Only proceed once the refined architectural path is conceptually bulletproof.
