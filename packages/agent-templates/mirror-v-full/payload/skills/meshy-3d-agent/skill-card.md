## Description: <br>
Generate 3D models, textures, images, rig characters, animate them, and prepare for 3D printing using the Meshy AI API. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[arlieeee](https://clawhub.ai/user/arlieeee) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
Developers, designers, and 3D printing users use this skill to generate, texture, rig, animate, download, and prepare Meshy AI assets through agent-guided API workflows. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The skill requires a Meshy API key and sends user prompts, image URLs, and the API key to the Meshy API. <br>
Mitigation: Use a dedicated project directory, avoid putting secrets in prompts or image inputs, and provide only a Meshy key intended for this workflow. <br>
Risk: Meshy workflows can consume paid credits. <br>
Mitigation: Confirm the estimated cost and current balance before creating tasks that spend credits. <br>
Risk: The skill can save generated files locally and print workflows may detect and open installed slicer applications. <br>
Mitigation: Review generated paths under meshy_output/ and approve slicer-opening steps only when that local application behavior is expected. <br>


## Reference(s): <br>
- [Meshy API Reference](reference.md) <br>
- [Meshy API Documentation](https://docs.meshy.ai) <br>
- [Meshy 3D Agent on ClawHub](https://clawhub.ai/arlieeee/meshy-3d-agent) <br>


## Skill Output: <br>
**Output Type(s):** [guidance, code, shell commands, configuration, files] <br>
**Output Format:** [Markdown guidance with inline shell commands and Python code for Meshy API workflows] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [May create local project files under meshy_output/ and may save .env in the current project only when explicitly requested.] <br>

## Skill Version(s): <br>
0.3.0 (source: server release metadata) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
