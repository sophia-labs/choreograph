# Choreograph Julia kernel launcher.
#
# The bridge's argv has to be stable, but IJulia lives at a content-addressed
# depot path (…/packages/IJulia/<slug>/src/kernel.jl) that moves whenever the
# pinned version changes. Launching this file keeps the depot hash out of the
# registry entry in src/kernel-bridges.ts.
#
# ARGS[1] is the connection file the Rust bridge wrote. IJulia.run_kernel()
# reads it out of ARGS itself, exactly as the upstream kernelspec does:
#   julia -i --color=yes --project=@. -e 'import IJulia; IJulia.run_kernel()' {connection_file}

if length(ARGS) != 1
    println(Core.stderr, "usage: launch_kernel.jl <connection-file>")
    exit(2)
end

if !isfile(ARGS[1])
    println(Core.stderr, "launch_kernel.jl: connection file does not exist: $(ARGS[1])")
    exit(2)
end

# DEPOT_PATH[1] is a tmpfs path inside the sandbox and starts out absent. Every
# package and every precompile cache resolves from the read-only baked depot
# stacked behind it, but Julia still wants a writable head for the cases where
# it decides to compile something itself.
if !isempty(DEPOT_PATH) && !isdir(DEPOT_PATH[1])
    mkpath(DEPOT_PATH[1])
end

import IJulia

IJulia.run_kernel()
