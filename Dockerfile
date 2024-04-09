FROM node:18.14

ARG PORT=3000

EXPOSE ${PORT}

WORKDIR /indexer
ADD . /indexer

CMD yarn start
