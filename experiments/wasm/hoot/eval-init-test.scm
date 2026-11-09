(import (scheme base)
        (hoot eval)
        (hoot user))

(eval '(+ 1 2) (interaction-environment))
